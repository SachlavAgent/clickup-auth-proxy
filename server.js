const express = require('express');
const app = express();
app.use(express.json());

const WEBSITE_URL = 'https://sachlavagent.github.io/Lead-Allocation/';
const CLICKUP_API_BASE = 'https://api.clickup.com/api/v2';

// Handle GET — ClickUp redirects here after user authorizes
app.get('/api/clickup-auth-web', async (req, res) => {
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

    // Redirect back to website with token in URL hash
    return res.redirect(
      `${WEBSITE_URL}#clickup_token=${encodeURIComponent(data.access_token)}`
    );
  } catch (err) {
    console.error('Token exchange error:', err);
    return res.redirect(`${WEBSITE_URL}?clickup_error=network_error`);
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});
