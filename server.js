import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3400);
const host = process.env.HOST || '127.0.0.1';
const isProduction = process.env.NODE_ENV === 'production';

app.get('/api/telnyx-credentials', (req, res) => {
  const loginToken = process.env.TELNYX_LOGIN_TOKEN?.trim();
  const login = process.env.TELNYX_SIP_USERNAME?.trim();
  const password = process.env.TELNYX_SIP_PASSWORD?.trim();
  const callerNumber = process.env.TELNYX_CALLER_NUMBER?.trim();

  if (loginToken) {
    return res.json({ login_token: loginToken, callerNumber });
  }

  if (login && password) {
    return res.json({ login, password, callerNumber });
  }

  return res.status(500).json({
    error:
      'Set TELNYX_LOGIN_TOKEN or TELNYX_SIP_USERNAME and TELNYX_SIP_PASSWORD in .env.',
  });
});

if (isProduction) {
  app.use(express.static(path.join(__dirname, 'dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  });
} else {
  const vite = await createViteServer({
    server: { middlewareMode: true, hmr: false },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}

app.listen(port, host, () => {
  console.log(`Telnyx dialer listening on http://${host}:${port}`);
});
