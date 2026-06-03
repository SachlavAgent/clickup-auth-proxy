import { createClient } from 'redis';
import { randomInt } from 'crypto';
import nodemailer from 'nodemailer';

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
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  const resendKey = process.env.RESEND_API_KEY;

  const subject = 'Your Sachlav Staff Hub Login Code';
  const text = `Your Sachlav Staff Hub verification code is: ${code}\n\nThis code expires in 10 minutes. If you didn't request this, you can safely ignore this email.`;
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#fff">
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px">
    <div style="width:44px;height:44px;background:#F4C55A;border-radius:12px;font-size:22px;font-weight:900;color:#1A1654;text-align:center;line-height:44px">S</div>
    <div>
      <div style="font-size:15px;font-weight:900;letter-spacing:2px;color:#1A1654">SACHLAV</div>
      <div style="font-size:11px;color:#C99524;font-weight:700">Staff Hub</div>
    </div>
  </div>
  <h2 style="color:#1A1654;margin:0 0 8px;font-size:22px;font-weight:800">Your verification code</h2>
  <p style="color:#555;margin:0 0 24px;font-size:15px;line-height:1.5">Your Sachlav Staff Hub verification code is:</p>
  <div style="background:#F4C55A;border-radius:12px;padding:20px 32px;text-align:center;font-size:44px;font-weight:900;letter-spacing:16px;color:#1A1654;margin-bottom:20px">${code}</div>
  <p style="color:#555;font-size:14px;margin:0 0 4px">This code expires in <strong>10 minutes</strong>.</p>
  <p style="color:#555;font-size:14px;margin:0 0 24px">Enter it in the Sachlav Staff Hub app to sign in.</p>
  <p style="color:#999;font-size:12px;margin:0">If you didn't request this, you can safely ignore this email.</p>
</div>`;

  if (gmailUser && gmailPass) {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: gmailUser, pass: gmailPass },
    });
    await transporter.sendMail({
      from: `"Sachlav Staff Hub" <${gmailUser}>`,
      to,
      subject,
      text,
      html,
    });
    return;
  }

  if (resendKey) {
    const from = process.env.EMAIL_FROM ?? 'Sachlav Staff Hub <onboarding@resend.dev>';
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}` },
      body: JSON.stringify({ from, to: [to], subject, html, text }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`Resend failed (${r.status}): ${body.slice(0, 200)}`);
    }
    return;
  }

  // Dev mode — no email provider configured, log the code to console.
  console.log(`[send-otp] DEV MODE — OTP for ${to}: ${code}`);
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
