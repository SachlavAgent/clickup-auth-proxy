import { createClient } from 'redis';
import { randomBytes } from 'crypto';
import { setCorsHeaders, checkApiKey, checkRateLimit, makeRedisGetter } from './_helpers.js';

const STAFFERS_KEY = 'sachlav:staffers:cache:v1';
const SESSION_TTL_SECONDS = 86400; // 24 h
const OTP_TTL_SECONDS = 600;

// Max failed verification attempts per email before the OTP is invalidated.
const VERIFY_RL_MAX = 5;
const VERIFY_RL_WINDOW = OTP_TTL_SECONDS;

const EMAIL_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
const CODE_RE = /^\d{6}$/;

const getRedisClient = makeRedisGetter(createClient, 'verify-otp');

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
    const code = (body?.code ?? '').trim();

    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'invalid_body', message: 'Invalid email format.' });
    }
    if (!code || !CODE_RE.test(code)) {
      return res.status(400).json({ error: 'invalid_body', message: 'Code must be a 6-digit number.' });
    }

    const redis = await getRedisClient();

    // ── Rate limit failed attempts ─────────────────────────────────────────────
    const rl = await checkRateLimit(redis, `rl:verify:${email}`, VERIFY_RL_MAX, VERIFY_RL_WINDOW);
    if (!rl.allowed) {
      // Too many wrong attempts — invalidate the OTP immediately.
      await redis.del(`otp:${email}`).catch(() => {});
      res.setHeader('Retry-After', String(rl.retryAfter ?? VERIFY_RL_WINDOW));
      return res.status(429).json({
        error: 'too_many_requests',
        message: 'Too many failed attempts. Request a new login code.',
      });
    }

    // ── Verify OTP ─────────────────────────────────────────────────────────────
    const storedCode = await redis.get(`otp:${email}`);
    if (!storedCode || String(storedCode) !== code) {
      return res.status(401).json({ error: 'invalid_code', message: 'Invalid or expired code. Please try again.' });
    }

    // Consume OTP immediately (prevents replay) and clear the rate-limit counter.
    await redis.del(`otp:${email}`);
    await redis.del(`rl:verify:${email}`).catch(() => {});

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

    // ── Issue session token — 256-bit entropy ──────────────────────────────────
    const token = randomBytes(32).toString('hex');
    const kind = isAdmin ? 'admin' : 'staffer';
    await redis.setEx(
      `session:${token}`,
      SESSION_TTL_SECONDS,
      JSON.stringify({ email, stafferId: staffer?.id ?? null, kind, createdAt: new Date().toISOString() })
    );

    // Strip password field before sending staffer data to the client.
    const safeStaffer = staffer ? (({ password: _pw, ...s }) => s)(staffer) : null;

    return res.status(200).json({ ok: true, token, kind, staffer: safeStaffer });
  } catch (err) {
    console.error('[verify-otp] error:', err);
    return res.status(500).json({ error: 'server_error', message: 'Internal server error.' });
  }
}
