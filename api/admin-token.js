import { createClient } from 'redis';

const TOKEN_KEY = 'sachlav:admin:clickup-token:v1';

let redisClient = null;

async function getRedisClient() {
  if (redisClient) return redisClient;
  redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', (err) => console.error('Redis error:', err));
  await redisClient.connect();
  return redisClient;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-secret');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const expected = process.env.ADMIN_SECRET;
  const provided = req.headers['x-admin-secret'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (expected && provided !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!body || typeof body.token !== 'string' || !body.token.trim()) {
      return res.status(400).json({ error: 'invalid_body', message: 'Expected { token: string }' });
    }

    const redis = await getRedisClient();
    await redis.set(TOKEN_KEY, JSON.stringify({ token: body.token.trim(), storedAt: new Date().toISOString() }));
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[api/admin-token] error:', err);
    return res.status(500).json({ error: 'internal_server_error' });
  }
}
