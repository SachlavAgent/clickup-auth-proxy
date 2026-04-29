// api/clickup-auth.ts
// Deploy this to Vercel. Set these environment variables in your Vercel project:
//   CLICKUP_CLIENT_ID     — from ClickUp Custom App
//   CLICKUP_CLIENT_SECRET — from ClickUp Custom App

import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Allow requests from your Expo app (adjust origin as needed)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { code } = req.body as { code?: string };

  if (!code) {
    return res.status(400).json({ error: "Missing code parameter" });
  }

  const clientId = process.env.CLICKUP_CLIENT_ID;
  const clientSecret = process.env.CLICKUP_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error("Missing CLICKUP_CLIENT_ID or CLICKUP_CLIENT_SECRET env vars");
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
      }),
    });

    const data = (await response.json()) as { access_token?: string; error?: string };

    if (!response.ok || !data.access_token) {
      console.error("ClickUp token exchange failed:", data);
      return res.status(400).json({ error: data.error ?? "Token exchange failed" });
    }

    return res.status(200).json({ access_token: data.access_token });
  } catch (err) {
    console.error("Token exchange error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
