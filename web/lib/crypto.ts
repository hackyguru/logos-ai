// Byte-compatible port of the C++ InferenceIdentity crypto (see
// inference-core/src/inference_identity.cpp) so a browser-side user can seal
// prompts the provider can open, open responses the provider sealed, verify
// signed announces/responses, and compute PoW stamps. Getting these
// bit-identical is the whole game — a mismatch means the provider silently
// can't read our prompt.
import { x25519, ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { hmac } from "@noble/hashes/hmac";
import { chacha20poly1305 } from "@noble/ciphers/chacha";

const enc = new TextEncoder();
export const b64 = (u: Uint8Array): string => Buffer.from(u).toString("base64");
export const unb64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));

function concat(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// provider id = first 20 bytes of SHA-256(ed25519 signing pubkey), hex.
export function fingerprintOf(signPk: Uint8Array): string {
  return Buffer.from(sha256(signPk).slice(0, 20)).toString("hex");
}

export function verify(msg: Uint8Array, sig: Uint8Array, signPk: Uint8Array): boolean {
  try { return ed25519.verify(sig, msg, signPk); } catch { return false; }
}

export interface EphKeys { sk: Uint8Array; pk: Uint8Array; }
export function genEphemeral(): EphKeys {
  const sk = x25519.utils.randomPrivateKey();
  return { sk, pk: x25519.getPublicKey(sk) };
}

// key + nonce from the ECDH shared secret, bound to both pubkeys (identical
// domain-separation strings to the C++ sealKdf).
function sealKdf(shared: Uint8Array, ephPk: Uint8Array, recipientPk: Uint8Array) {
  const binding = concat(ephPk, recipientPk);
  const key = hmac(sha256, shared, concat(enc.encode("inference/v1/seal-key"), binding));
  const nonce = hmac(sha256, shared, concat(enc.encode("inference/v1/seal-nonce"), binding)).slice(0, 12);
  return { key, nonce };
}

// Seal `plaintext` to a recipient's X25519 public key. Wire: ephPk(32) ‖ ct ‖ tag(16).
// (noble's chacha20poly1305.encrypt appends the 16-byte tag, matching OpenSSL's ct+tag.)
export function seal(recipientPk: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const { sk: ephSk, pk: ephPk } = genEphemeral();
  const shared = x25519.getSharedSecret(ephSk, recipientPk);
  const { key, nonce } = sealKdf(shared, ephPk, recipientPk);
  const ctTag = chacha20poly1305(key, nonce).encrypt(plaintext);
  return concat(ephPk, ctTag);
}

// Open a box sealed to the public key matching `secretKey`. Returns null on
// tamper / wrong key (tag mismatch throws in noble → caught).
export function openWith(secretKey: Uint8Array, sealed: Uint8Array): Uint8Array | null {
  if (sealed.length < 32 + 16) return null;
  const ephPk = sealed.slice(0, 32);
  const ctTag = sealed.slice(32);
  const recipientPk = x25519.getPublicKey(secretKey);
  const shared = x25519.getSharedSecret(secretKey, ephPk);
  const { key, nonce } = sealKdf(shared, ephPk, recipientPk);
  try { return chacha20poly1305(key, nonce).decrypt(ctTag); } catch { return null; }
}

// Hashcash: find a nonce so SHA-256(promptId|providerFp|nonce) has `bits`
// leading zero bits. Same construction as the C++ provider/client.
export function computePow(promptId: string, providerFp: string, bits: number): string | null {
  const prefix = enc.encode(`${promptId}|${providerFp}|`);
  for (let n = 0; n < (1 << 26); n++) {
    const nonce = enc.encode(n.toString(16));
    const d = sha256(concat(prefix, nonce));
    let zeros = 0;
    for (const c of d) {
      if (c === 0) { zeros += 8; continue; }
      for (let b = 7; b >= 0 && !((c >> b) & 1); b--) zeros++;
      break;
    }
    if (zeros >= bits) return n.toString(16);
  }
  return null;
}
