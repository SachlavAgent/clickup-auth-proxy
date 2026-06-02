import { createClient } from 'redis';
import { randomInt } from 'crypto';

const STAFFERS_KEY = 'sachlav:staffers:cache:v1';
const OTP_TTL_SECONDS = 600;

let redisClient = null;

async function getRedisClient() {
  if (redisClient) return redisClient;
  redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', (err) => console.error('[send-otp] Redis error:', err));
  await redisClient.connect();
  return redisClient;
}

async function sendOtpEmail(to, code) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[send-otp] DEV — OTP for ${to}: ${code}`);
    return;
  }
  const from = process.env.EMAIL_FROM ?? 'Sachlav Staff Hub <noreply@sachlav.app>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      from,
      to: [to],
      subject: 'Your Sachlav login code',
      html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#fff">
        <h2 style="color:#1A1654;margin:0 0 8px;font-size:22px">Your login code</h2>
        <p style="color:#555;margin:0 0 24px;font-size:15px">Use this code to sign in to Sachlav Staff Hub. It expires in 10 minutes.</p>
        <div style="background:#F4C55A;border-radius:12px;padding:20px 32px;text-align:center;font-size:40px;font-weight:900;letter-spacing:16px;color:#1A1654">${code}</div>
        <p style="color:#999;font-size:12px;margin:24px 0 0">If you didn't request this, you can safely ignore this email.</p>
      </div>`,
      text: `Your Sachlav login code is: ${code}\n\nExpires in 10 minutes.`,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Resend failed (${res.status}): ${text.slice(0, 200)}`);
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
    await sendOtpEmail(email, code);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[send-otp] error:', err);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
}
