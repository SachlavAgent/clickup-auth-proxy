import { createClient } from 'redis';
import { setCorsHeaders, checkApiKey, makeRedisGetter } from './_helpers.js';

// stafferId must be a ClickUp task ID: alphanumeric, 4–32 chars.
const STAFFER_ID_RE = /^[a-zA-Z0-9]{4,32}$/;
// pushToken: Expo push token format or plain hex/base64. Max 500 chars, no control chars.
const PUSH_TOKEN_RE = /^[a-zA-Z0-9+/=_\-\[\]]{10,500}$/;
// groupName: optional trip ID or empty string.
const GROUP_NAME_RE = /^$|^[A-Z]{2,4}-[A-Z]{2,4}-\d{1,4}-\d{1,4}$/;

const getRedisClient = makeRedisGetter(createClient, 'save-push-token');

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  setCorsHeaders(res, req, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  // ── Auth ────────────────────────────────────────────────────────────────────
  if (!checkApiKey(req, res)) return;

  const body = req.body ?? {};
  const stafferId = (body.stafferId ?? '').trim();
  const pushToken = (body.pushToken ?? '').trim();
  const groupName = (body.groupName ?? '').trim().toUpperCase();

  // ── Input validation ────────────────────────────────────────────────────────
  if (!stafferId || !STAFFER_ID_RE.test(stafferId)) {
    return res.status(400).json({ error: 'invalid_staffer_id', required: 'alphanumeric, 4–32 chars' });
  }
  if (!pushToken || !PUSH_TOKEN_RE.test(pushToken)) {
    return res.status(400).json({ error: 'invalid_push_token' });
  }
  if (!GROUP_NAME_RE.test(groupName)) {
    return res.status(400).json({ error: 'invalid_group_name' });
  }

  try {
    const redis = await getRedisClient();
    await redis.set(`push:token:${stafferId}`, JSON.stringify({ pushToken, groupName }));
    console.log(`[api/save-push-token] saved stafferId=${stafferId}`);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[api/save-push-token] error:', err);
    return res.status(500).json({ error: 'internal_server_error' });
  }
}
