import type { NextApiRequest, NextApiResponse } from "next";
export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  const { ensureStarted, getProviders } = await import("../../lib/inferenceClient");
  ensureStarted();
  res.status(200).json({ providers: getProviders() });
}
