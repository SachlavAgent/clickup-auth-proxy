import { createClient } from 'redis';
import { randomInt } from 'crypto';
import nodemailer from 'nodemailer';
import { setCorsHeaders, checkApiKey, getClientIp, checkRateLimit, makeRedisGetter } from './_helpers.js';

const STAFFERS_KEY = 'sachlav:staffers:cache:v1';
const OTP_TTL_SECONDS = 600;

// Rate limits: 5 sends per email per 15 min, 20 per IP per hour.
const EMAIL_RL_MAX = 5;
const EMAIL_RL_WINDOW = 900;
const IP_RL_MAX = 20;
const IP_RL_WINDOW = 3600;

const EMAIL_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

const getRedisClient = makeRedisGetter(createClient, 'send-otp');

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
    await transporter.sendMail({ from: `"Sachlav Staff Hub" <${gmailUser}>`, to, subject, text, html });
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

  // Dev mode — log that email was sent but never log the code value.
  console.log(`[send-otp] DEV MODE — OTP sent to ${to} (no email provider configured)`);
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  setCorsHeaders(res, req, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  // ── Auth ────────────────────────────────────────────────────────────────────
  if (!checkApiKey(req, res)) return;

  try {
    const body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    const email = (body?.email ?? '').trim().toLowerCase();

    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'invalid_body', message: 'Expected { email: string }' });
    }

    const redis = await getRedisClient();

    // ── Rate limiting ──────────────────────────────────────────────────────────
    const ip = getClientIp(req);
    const [emailRl, ipRl] = await Promise.all([
      checkRateLimit(redis, `rl:send:email:${email}`, EMAIL_RL_MAX, EMAIL_RL_WINDOW),
      checkRateLimit(redis, `rl:send:ip:${ip}`, IP_RL_MAX, IP_RL_WINDOW),
    ]);

    if (!emailRl.allowed) {
      res.setHeader('Retry-After', String(emailRl.retryAfter ?? EMAIL_RL_WINDOW));
      return res.status(429).json({ error: 'too_many_requests', message: 'Too many login attempts. Please wait before trying again.' });
    }
    if (!ipRl.allowed) {
      res.setHeader('Retry-After', String(ipRl.retryAfter ?? IP_RL_WINDOW));
      return res.status(429).json({ error: 'too_many_requests', message: 'Too many requests from this location.' });
    }

    // ── Staffer lookup — fail closed if cache is empty ─────────────────────────
    const adminEmail = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
    const isAdmin = adminEmail && email === adminEmail;

    if (!isAdmin) {
      const raw = await redis.get(STAFFERS_KEY);
      if (raw === null) {
        // Fail closed — never allow login when the staff registry is unavailable.
        console.error('[send-otp] staffer cache empty — rejecting OTP request');
        return res.status(503).json({
          error: 'service_unavailable',
          message: 'Staff registry is temporarily unavailable. Please try again in a few minutes.',
        });
      }
      const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const staffers = Array.isArray(value?.staffers) ? value.staffers : [];
      const found = staffers.some((s) => (s.email ?? '').trim().toLowerCase() === email);
      if (!found) {
        return res.status(404).json({ error: 'not_found', message: 'This email is not registered in the staff list.' });
      }
    }

    // ── Generate and store OTP ─────────────────────────────────────────────────
    const code = String(randomInt(100000, 1000000));
    await redis.setEx(`otp:${email}`, OTP_TTL_SECONDS, code);
    await sendOtpEmail(email, code);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[send-otp] error:', err);
    return res.status(500).json({ error: 'server_error', message: 'Internal server error.' });
  }
}
