import type { NextApiRequest, NextApiResponse } from "next";
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { getResult } = await import("../../lib/inferenceClient");
  const id = String(req.query.id ?? "");
  if (!id) return res.status(400).json({ error: "id required" });
  res.status(200).json(getResult(id));
}
