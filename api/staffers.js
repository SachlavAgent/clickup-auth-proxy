import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const CACHE_KEY = "sachlav:staffers:cache:v1";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-admin-secret"
  );
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.length > 0) {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      if (!data) return resolve(null);
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(null);
      }
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

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    res.status(500).json({
      error: "redis_not_configured",
      message:
        "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set in Vercel env vars.",
    });
    return;
  }

  try {
    if (req.method === "GET") {
      const payload = await redis.get(CACHE_KEY);
      if (!payload) {
        res.status(200).json({ staffers: [], updatedAt: null });
        return;
      }
      const value = typeof payload === "string" ? JSON.parse(payload) : payload;
      res.status(200).json({
        staffers: Array.isArray(value?.staffers) ? value.staffers : [],
        updatedAt: value?.updatedAt ?? null,
      });
      return;
    }

    if (req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body || !Array.isArray(body.staffers)) {
        res.status(400).json({ error: "invalid_body", message: "Expected { staffers: [...] }" });
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

      const value = {
        staffers: body.staffers,
        updatedAt: new Date().toISOString(),
      };
      await redis.set(CACHE_KEY, JSON.stringify(value));
      res.status(200).json({ ok: true, count: body.staffers.length, updatedAt: value.updatedAt });
      return;
    }

    res.status(405).json({ error: "method_not_allowed" });
  } catch (err) {
    console.error("[api/staffers] error", err);
    res.status(500).json({ error: "server_error", message: String(err?.message || err) });
  }
}
