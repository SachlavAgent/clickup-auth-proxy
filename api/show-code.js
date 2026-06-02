// Firebase redirects here after the user taps the sign-in link in their email.
// We display the 6-digit OTP code so the user can type it into the app.
export default function handler(req, res) {
  const code = (req.query.code ?? '').replace(/[^0-9]/g, '').slice(0, 6);

  if (!code || code.length !== 6) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(400).send(`<!DOCTYPE html><html><body style="font-family:system-ui;text-align:center;padding:60px;background:#14123A;color:#F8F6FF">
      <p style="color:#FF6B6B;font-size:18px">Invalid or expired link.</p>
    </body></html>`);
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Your Sachlav Sign-In Code</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#14123A;color:#F8F6FF;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;
         min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{background:#1C1A4D;border:1px solid rgba(244,197,90,.18);border-radius:24px;
          padding:40px 32px;max-width:380px;width:100%;text-align:center}
    .logo{width:52px;height:52px;background:#F4C55A;border-radius:14px;
          font-size:26px;font-weight:900;color:#1A1654;display:flex;align-items:center;
          justify-content:center;margin:0 auto 20px}
    h1{font-size:22px;font-weight:900;margin-bottom:8px}
    .sub{color:rgba(166,162,217,.75);font-size:14px;margin-bottom:32px;line-height:1.5}
    .code-box{background:rgba(244,197,90,.12);border:2px solid #F4C55A;border-radius:16px;
              padding:24px 16px;margin-bottom:28px}
    .code{font-size:52px;font-weight:900;letter-spacing:14px;color:#F4C55A;
          font-variant-numeric:tabular-nums}
    .hint{color:rgba(166,162,217,.75);font-size:13px;margin-top:8px}
    .note{color:rgba(166,162,217,.6);font-size:12px;line-height:1.6}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">S</div>
    <h1>Your sign-in code</h1>
    <p class="sub">Enter this code in the Sachlav Staff Hub app.<br/>It expires in 10 minutes.</p>
    <div class="code-box">
      <div class="code">${code}</div>
      <div class="hint">6-digit code</div>
    </div>
    <p class="note">Go back to the app and enter this code to sign in.<br/>If you didn't request this, ignore it.</p>
  </div>
</body>
</html>`);
}
