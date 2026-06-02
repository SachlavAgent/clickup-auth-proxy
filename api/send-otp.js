import { createClient } from 'redis';
import { randomInt } from 'crypto';

const STAFFERS_KEY = 'sachlav:staffers:cache:v1';
const OTP_TTL_SECONDS = 600; // 10 minutes

let redisClient = null;

async function getRedisClient() {
  if (redisClient) return redisClient;
  redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', (err) => console.error('[send-otp] Redis error:', err));
  await redisClient.connect();
  return redisClient;
}

// Firebase sends the email. The sign-in link redirects to /api/show-code
// which displays the 6-digit code as an HTML page the user reads on their phone.
async function sendViaFirebase(email, code) {
  const apiKey = process.env.FIREBASE_API_KEY;
  if (!apiKey) throw new Error('FIREBASE_API_KEY is not configured.');

  // show-code page lives on project-ks6k6.vercel.app.
  // That domain must be in Firebase > Authentication > Settings > Authorized domains.
  const showCodeUrl =
    `https://project-ks6k6.vercel.app/api/show-code` +
    `?code=${code}&e=${encodeURIComponent(email)}`;

  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestType: 'EMAIL_SIGNIN',
        email,
        continueUrl: showCodeUrl,
      }),
    }
  );

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = body?.error?.message ?? JSON.stringify(body);
    throw new Error(`Firebase sendOobCode failed (${res.status}): ${msg}`);
  }
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

    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'invalid_body', message: 'Expected { email: string }' });
    }

    const adminEmail = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
    const isAdmin = adminEmail && email === adminEmail;

    if (!isAdmin) {
      const redis = await getRedisClient();
      const raw = await redis.get(STAFFERS_KEY);
      if (raw) {
        const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const staffers = Array.isArray(value?.staffers) ? value.staffers : [];
        const found = staffers.some((s) => (s.email ?? '').trim().toLowerCase() === email);
        if (!found) {
          return res.status(404).json({
            error: 'not_found',
            message: 'This email is not registered in the staff list.',
          });
        }
      } else {
        console.warn('[send-otp] staffer cache empty — allowing through');
      }
    }

    const code = String(randomInt(100000, 1000000));
    const redis = await getRedisClient();
    await redis.setEx(`otp:${email}`, OTP_TTL_SECONDS, code);

    await sendViaFirebase(email, code);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[send-otp] error:', err);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
}
