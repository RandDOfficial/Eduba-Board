const { Hono } = require('hono');
const { getCookie } = require('hono/cookie');
const { cors } = require('hono/cors');
const { auth } = require('./modules/auth');
const { boards } = require('./modules/boards');
const { upload } = require('./modules/upload');

const db = require('./modules/db');

const app = new Hono();

// Global CORS middleware
app.use('*', cors({
  origin: (origin) => origin || '*',
  credentials: true
}));

// Cloudflare D1 environment bridge
app.use('*', async (c, next) => {
  if (c.env?.eduba_db || c.env?.DB) {
    db.setD1(c.env.eduba_db || c.env.DB);
  }
  await next();
});

// Mount API routes
app.route('/api/auth', auth);
app.route('/api/boards', boards);
app.route('/api/upload', upload);

// Root entry redirect
app.get('/', (c) => {
  const token = getCookie(c, 'session_token');
  if (token) {
    return c.redirect('/dashboard.html');
  }
  return c.redirect('/login.html');
});

// Health check endpoint
app.get('/health', (c) => {
  return c.json({ status: 'ok', time: new Date().toISOString() });
});

module.exports = {
  app
};
