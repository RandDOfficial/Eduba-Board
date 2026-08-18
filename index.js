const fs = require('fs');
const path = require('path');
const defaultLogDir = process.env.NODE_ENV === 'production' ? path.join(__dirname, 'data', 'logs') : path.join(__dirname, 'logs');
const logDir = process.env.LOG_DIR || (process.env.DB_PATH ? path.join(path.dirname(process.env.DB_PATH), 'logs') : defaultLogDir);
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}
require('elenora').connect(console, { filename: path.join(logDir, 'app.log'), maxSize: 1024 * 1024, backupCount: 3, continueFromLast: true, interval: 60 * 1000 });
const fastify = require('fastify')({ bodyLimit: 100 * 1024 * 1024 });

fastify.register(require('@fastify/cookie'), { secret: 'eduba-super-secret' });
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

fastify.listen({ port: 3000, host: '0.0.0.0' }, (err, address) => {
  if (err) { console.error(err); process.exit(1); }
  console.log('Eduba Board -> ' + address);
});
