const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const defaultLogDir = process.env.NODE_ENV === 'production' ? path.join(__dirname, 'data', 'logs') : path.join(__dirname, 'logs');
const logDir = process.env.LOG_DIR || (process.env.DB_PATH ? path.join(path.dirname(process.env.DB_PATH), 'logs') : defaultLogDir);
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}
require('elenora').connect(console, { filename: path.join(logDir, 'app.log'), maxSize: 1024 * 1024, backupCount: 3, continueFromLast: true, interval: 60 * 1000 });

function getSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;

  const dataDir = process.env.DB_PATH
    ? path.dirname(process.env.DB_PATH)
    : path.join(__dirname, 'data');

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const secretFile = path.join(dataDir, 'cookie_secret.key');
  if (fs.existsSync(secretFile)) {
    try {
      const secret = fs.readFileSync(secretFile, 'utf8').trim();
      if (secret.length >= 16) return secret;
    } catch (e) {}
  }

  const newSecret = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(secretFile, newSecret, { encoding: 'utf8' });
  } catch (e) {
    console.warn('[auth] Could not persist cookie secret to disk:', e.message);
  }
  return newSecret;
}

const fastify = require('fastify')({ bodyLimit: 100 * 1024 * 1024 });

fastify.register(require('@fastify/cookie'), { secret: getSessionSecret() });
fastify.register(require('@fastify/websocket'), {
  options: {
    maxPayload: 100 * 1024 * 1024
  }
});
fastify.register(require('@fastify/static'), {
  root: __dirname + '/public',
  prefix: '/',
});

require('./modules/auth')(fastify);
require('./modules/boards')(fastify);
require('./modules/ws')(fastify);
require('./modules/backup').init();

fastify.get('/', (request, reply) => {
  const token = request.cookies.session_token;
  if (token) {
    return reply.redirect('/dashboard.html');
  }
  return reply.redirect('/login.html');
});

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
fastify.listen({ port, host: '0.0.0.0' }, (err, address) => {
  if (err) { console.error(err); process.exit(1); }
  console.log('Eduba Board -> ' + address);
});
