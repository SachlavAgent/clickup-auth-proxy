// api/staffers.js
// Read-only cache endpoint. Populated by the daily cron in refresh-staffers.js.

import { createClient } from 'redis';

const CACHE_KEY = 'sachlav:staffers:cache:v1';

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  try {
    const redis = await getRedisClient();
    const data = await redis.get(CACHE_KEY);

    if (!data) {
      return res.status(200).json({ staffers: [], updatedAt: null });
    }

    const value = typeof data === 'string' ? JSON.parse(data) : data;
    const raw = Array.isArray(value?.staffers) ? value.staffers : [];
    // Never expose passwords — strip the field regardless of how it reached the cache
    const staffers = raw.map(({ password, ...s }) => s);
    return res.status(200).json({
      staffers,
      updatedAt: value?.updatedAt ?? null,
    });
  } catch (err) {
    console.error('[api/staffers] error:', err);
    return res.status(500).json({ error: 'internal_server_error' });
  }
}
