import { createClient } from 'redis';
import { randomUUID } from 'crypto';

const STAFFERS_KEY = 'sachlav:staffers:cache:v1';
const SESSION_TTL_SECONDS = 86400; // 24 h

let redisClient = null;

async function getRedisClient() {
  if (redisClient) return redisClient;
  redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', (err) => console.error('[verify-otp] Redis error:', err));
  await redisClient.connect();
  return redisClient;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  try {
    const body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    const email = (body?.email ?? '').trim().toLowerCase();
    const code = (body?.code ?? '').trim();

    if (!email || !code) {
      return res.status(400).json({ error: 'invalid_body', message: 'Expected { email, code }' });
    }

    const redis = await getRedisClient();

    const storedCode = await redis.get(`otp:${email}`);
    if (!storedCode || String(storedCode) !== code) {
      return res.status(401).json({ error: 'invalid_code', message: 'Invalid or expired code. Please try again.' });
    }

    await redis.del(`otp:${email}`);

    const adminEmail = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
    const isAdmin = !!(adminEmail && email === adminEmail);

    let staffer = null;
    const raw = await redis.get(STAFFERS_KEY);
    if (raw) {
      const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const staffers = Array.isArray(value?.staffers) ? value.staffers : [];
      staffer = staffers.find((s) => (s.email ?? '').trim().toLowerCase() === email) ?? null;
    }

    if (!staffer && !isAdmin) {
      return res.status(403).json({ error: 'not_registered', message: 'Staffer not found in registry. Contact your coordinator.' });
    }

    const token = randomUUID();
    const kind = isAdmin ? 'admin' : 'staffer';
    await redis.setEx(
      `session:${token}`,
      SESSION_TTL_SECONDS,
      JSON.stringify({ email, stafferId: staffer?.id ?? null, kind, createdAt: new Date().toISOString() })
    );

    return res.status(200).json({ ok: true, token, kind, staffer });
  } catch (err) {
    console.error('[verify-otp] error:', err);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
}
