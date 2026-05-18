import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TOKEN_KEY = "sachlav:admin:clickup-token:v1";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-admin-secret");
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.length > 0) {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      if (!data) return resolve(null);
      try { resolve(JSON.parse(data)); } catch { resolve(null); }
    });
    req.on("error", () => resolve(null));
  });
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    res.status(500).json({ error: "redis_not_configured" });
    return;
  }

  const adminSecret = process.env.ADMIN_WRITE_SECRET;
  if (adminSecret) {
    const provided =
      req.headers["x-admin-secret"] ||
      (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (provided !== adminSecret) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
  }

  const body = await readJsonBody(req);
  if (!body || typeof body.token !== "string" || !body.token.trim()) {
    res.status(400).json({ error: "invalid_body", message: "Expected { token: string }" });
    return;
  }

  try {
    await redis.set(TOKEN_KEY, JSON.stringify({ token: body.token.trim(), storedAt: new Date().toISOString() }));
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[api/admin-token] error", err);
    res.status(500).json({ error: "server_error", message: String(err?.message || err) });
  }
}
