import type { NextApiRequest, NextApiResponse } from "next";
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { submitPrompt } = await import("../../lib/inferenceClient");
  const { text, model, providerId } = req.body ?? {};
  if (!text || typeof text !== "string") return res.status(400).json({ error: "text required" });
  const out = await submitPrompt(text.trim(), model || undefined, providerId || undefined);
  res.status(out.error ? 400 : 200).json(out);
}
