const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { serve } = require('@hono/node-server');
const { serveStatic } = require('@hono/node-server/serve-static');
const { app } = require('./app');
const { setupWebSocketHandler } = require('./modules/ws');
require('./modules/backup').init();

// Logger directory setup
const defaultLogDir = process.env.NODE_ENV === 'production' ? path.join(__dirname, 'data', 'logs') : path.join(__dirname, 'logs');
const logDir = process.env.LOG_DIR || (process.env.DB_PATH ? path.join(path.dirname(process.env.DB_PATH), 'logs') : defaultLogDir);
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}
require('elenora').connect(console, { filename: path.join(logDir, 'app.log'), maxSize: 1024 * 1024, backupCount: 3, continueFromLast: true, interval: 60 * 1000 });

// Ensure session secret key exists
function ensureSessionSecret() {
  if (process.env.SESSION_SECRET) return;

  const dataDir = process.env.DB_PATH
    ? path.dirname(process.env.DB_PATH)
    : path.join(__dirname, 'data');

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const secretFile = path.join(dataDir, 'cookie_secret.key');
  if (!fs.existsSync(secretFile)) {
    const newSecret = crypto.randomBytes(32).toString('hex');
    try {
      fs.writeFileSync(secretFile, newSecret, { encoding: 'utf8' });
    } catch (e) {
      console.warn('[auth] Could not persist cookie secret to disk:', e.message);
    }
  }
}
ensureSessionSecret();

// Serve uploaded media files from data/uploads (persisted Docker volume)
const uploadsDir = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.join(__dirname, 'data', 'uploads');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use('/uploads/*', async (c) => {
  const filename = c.req.param('*');
  const filepath = path.join(uploadsDir, filename);
  if (!fs.existsSync(filepath)) return c.notFound();
  const ext = path.extname(filename).toLowerCase().slice(1);
  const mimeMap = {
    mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml'
  };
  const mime = mimeMap[ext] || 'application/octet-stream';
  const data = fs.readFileSync(filepath);
  return new Response(data, { headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000' } });
});

// Serve static assets from public directory
app.use('/*', serveStatic({ root: './public' }));

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const server = serve({
  fetch: app.fetch,
  port,
  hostname: '0.0.0.0'
}, (info) => {
  console.log(`Eduba Board -> http://0.0.0.0:${info.port}`);
});

// Attach WebSocket server to the HTTP server
setupWebSocketHandler(server);
