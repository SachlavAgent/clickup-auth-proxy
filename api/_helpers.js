// Shared security helpers for all API routes in this project.

export const ALLOWED_ORIGINS = new Set([
  'https://project-ks6k6.vercel.app',
  'http://localhost:8081',
  'http://localhost:19006',
]);

export function setCorsHeaders(res, req, methods = 'GET, OPTIONS') {
  const origin = req?.headers?.origin ?? '';
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Authorization');
}

// API key is always required. If API_SECRET_KEY is unset the endpoint is locked.
export function checkApiKey(req, res) {
  const secret = process.env.API_SECRET_KEY;
  if (!secret) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  const provided = req.headers['x-api-key'] ?? '';
  if (provided !== secret) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

// Auth for cron/admin endpoints: accepts CRON_SECRET (Bearer) OR API_SECRET_KEY (x-api-key).
// Fails closed if neither is configured.
export function checkCronOrApiKey(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  const apiSecret = process.env.API_SECRET_KEY;

  if (cronSecret) {
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (bearer === cronSecret) return true;
  }
  if (apiSecret) {
    const key = req.headers['x-api-key'] ?? '';
    if (key === apiSecret) return true;
  }
  // Fail closed — at least one secret must be configured and matched.
  res.status(401).json({ error: 'unauthorized' });
  return false;
}

export function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}

// Fixed-window rate limiter using an existing Redis client instance.
// Returns { allowed: boolean, retryAfter: number|null }
export async function checkRateLimit(redis, key, maxRequests, windowSeconds) {
  const current = await redis.incr(key);
  if (current === 1) await redis.expire(key, windowSeconds);
  if (current <= maxRequests) return { allowed: true, retryAfter: null };
  const ttl = await redis.ttl(key);
  return { allowed: false, retryAfter: ttl > 0 ? ttl : windowSeconds };
}

// Reconnect-safe persistent Redis getter for serverless warm reuse.
export function makeRedisGetter(createClient, label) {
  let client = null;
  return async function getRedisClient() {
    if (client && client.isReady) return client;
    if (client) {
      try { await client.quit(); } catch {}
      client = null;
    }
    client = createClient({
      url: process.env.REDIS_URL,
      socket: { connectTimeout: 5000 },
    });
    client.on('error', (err) => console.error(`[${label}] Redis error:`, err));
    await client.connect();
    return client;
  };
}
