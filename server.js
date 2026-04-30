const express = require('express');
const app = express();
app.use(express.json());

// Allow requests from the Lead Allocation website
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://sachlavagent.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-clickup-token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

const WEBSITE_URL = 'https://sachlavagent.github.io/Lead-Allocation/';

// ── OAuth callback handler ────────────────────────────────────────────────────

async function handleClickUpCallback(req, res) {
  const { code, error } = req.query;

  if (error) {
    return res.redirect(`${WEBSITE_URL}?clickup_error=${encodeURIComponent(String(error))}`);
  }

  if (!code) {
    return res.redirect(`${WEBSITE_URL}?clickup_error=missing_code`);
  }

  const clientId = process.env.CLICKUP_WEB_CLIENT_ID;
  const clientSecret = process.env.CLICKUP_WEB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('Missing CLICKUP_WEB_CLIENT_ID or CLICKUP_WEB_CLIENT_SECRET');
    return res.redirect(`${WEBSITE_URL}?clickup_error=server_misconfiguration`);
  }

  try {
    const response = await fetch('https://api.clickup.com/api/v2/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code: String(code),
      }),
    });

    const data = await response.json();

    if (!response.ok || !data.access_token) {
      console.error('ClickUp token exchange failed:', data);
      return res.redirect(
        `${WEBSITE_URL}?clickup_error=${encodeURIComponent(data.error ?? 'token_exchange_failed')}`
      );
    }

    return res.redirect(
      `${WEBSITE_URL}#clickup_token=${encodeURIComponent(data.access_token)}`
    );
  } catch (err) {
    console.error('Token exchange error:', err);
    return res.redirect(`${WEBSITE_URL}?clickup_error=network_error`);
  }
}

// Root route — ClickUp redirects here with ?code=
app.get('/', async (req, res) => {
  if (req.query.code || req.query.error) {
    return handleClickUpCallback(req, res);
  }
  res.send('OK');
});

// Also handle at full path
app.get('/api/clickup-auth-web', handleClickUpCallback);

// ── ClickUp API proxy (avoids CORS issues from browser) ───────────────────────

app.all('/clickup-api/*', async (req, res) => {
  const token = req.headers['x-clickup-token'];
  if (!token) return res.status(401).json({ error: 'Missing x-clickup-token header' });

  // Build the ClickUp URL from the path after /clickup-api
  const clickupPath = req.path.replace('/clickup-api', '');
  const queryString = Object.keys(req.query).length
    ? '?' + new URLSearchParams(req.query).toString()
    : '';
  const clickupUrl = `https://api.clickup.com/api/v2${clickupPath}${queryString}`;

  console.log(`[Proxy] ${req.method} ${clickupUrl}`);

  try {
    const response = await fetch(clickupUrl, {
      method: req.method,
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json',
      },
      body: req.method !== 'GET' && req.method !== 'HEAD'
        ? JSON.stringify(req.body)
        : undefined,
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error('[Proxy] Error:', err);
    res.status(500).json({ error: 'Proxy error' });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});
