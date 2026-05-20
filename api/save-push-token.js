import { createClient } from 'redis';

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const { stafferId, pushToken, groupName } = req.body ?? {};
  if (!stafferId || !pushToken) {
    return res.status(400).json({ error: 'missing_fields', required: ['stafferId', 'pushToken'] });
  }

  try {
    const redis = await getRedisClient();
    await redis.set(`push:token:${stafferId}`, JSON.stringify({ pushToken, groupName: groupName ?? '' }));
    console.log(`[api/save-push-token] saved stafferId=${stafferId} groupName=${groupName}`);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[api/save-push-token] error:', err);
    return res.status(500).json({ error: 'internal_server_error', message: err.message });
  }
}
