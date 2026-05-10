// api/staffers.js
// Shared staffer cache using Redis Cloud (REDIS_URL env var)

import { createClient } from 'redis';

const KEY = 'staffers:default';

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-secret');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const redis = await getRedisClient();

    if (req.method === 'GET') {
      const data = await redis.get(KEY);
      if (!data) return res.status(404).json({ error: 'not_found' });
      return res.status(200).json(JSON.parse(data));
    }

    if (req.method === 'POST') {
      const expected = process.env.ADMIN_SECRET;
      const provided = req.headers['x-admin-secret'];
      if (expected && provided !== expected) {
        return res.status(401).json({ error: 'unauthorized' });
      }

      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (!body || !Array.isArray(body.data)) {
        return res.status(400).json({ error: 'invalid_body' });
      }

      await redis.set(KEY, JSON.stringify({ data: body.data, updatedAt: new Date().toISOString() }));
      return res.status(200).json({ ok: true, count: body.data.length });
    }

    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (err) {
    console.error('Staffers handler error:', err);
    return res.status(500).json({ error: 'internal_server_error' });
  }
}
