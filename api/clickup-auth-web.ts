// api/clickup-auth-web.ts
// Add this file to your existing clickup-auth-proxy GitHub repo.
// This handles OAuth for the Lead Allocation WEBSITE (separate from the mobile app).
// Uses the same CLICKUP_CLIENT_ID and CLICKUP_CLIENT_SECRET env vars already in Vercel.

import type { VercelRequest, VercelResponse } from "@vercel/node";

const REDIRECT_URI = "https://sachlavagent.github.io/Lead-Allocation/callback.html";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "https://sachlavagent.github.io");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { code } = req.body as { code?: string };
  if (!code) return res.status(400).json({ error: "Missing code parameter" });

  const clientId = process.env.CLICKUP_CLIENT_ID;
  const clientSecret = process.env.CLICKUP_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: "Server misconfiguration" });
  }

  try {
    const response = await fetch("https://api.clickup.com/api/v2/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });

    const data = (await response.json()) as { access_token?: string; error?: string };

    if (!response.ok || !data.access_token) {
      return res.status(400).json({ error: data.error ?? "Token exchange failed" });
    }

    return res.status(200).json({ access_token: data.access_token });
  } catch (err) {
    console.error("Token exchange error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
