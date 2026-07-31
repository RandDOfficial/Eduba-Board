const bcrypt = require('bcrypt');
const crypto = require('crypto');
const db = require('./db');

module.exports = function(fastify) {
  // Backend validation functions
  const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const isValidName = (name) => typeof name === 'string' && name.trim().length >= 2 && name.trim().length <= 40;

  fastify.decorateRequest('user', null);
  fastify.addHook('preHandler', async (request, reply) => {
    const token = request.cookies.session_token;
    if (token) {
      const res = await db.query('SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = $1 AND s.expires > now()', [token]);
      if (res.rows[0]) request.user = res.rows[0];
    }
  });

  const requireUser = async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });
  };
  fastify.decorate('requireUser', requireUser);

  fastify.post('/api/auth/register', async (request, reply) => {
    const allowRegistration = process.env.ALLOW_REGISTRATION !== 'false';
    if (!allowRegistration) {
      return reply.code(403).send({ error: 'Yeni kullanıcı kayıtları yönetici tarafından kapatılmıştır.' });
    }
    const { email, password, name } = request.body;
    if (!isValidName(name)) return reply.code(400).send({ error: 'Kullanıcı adı 2-40 karakter arasında olmalıdır.' });
    if (!email || !password || password.length < 6) {
      return reply.code(400).send({ error: 'Geçersiz e-posta veya kısa şifre (en az 6 karakter olmalı).' });
    }
    if (!isValidEmail(email)) {
      return reply.code(400).send({ error: 'Lütfen geçerli bir e-posta adresi girin.' });
    }
    const hash = await bcrypt.hash(password, 10);
    try {
      const res = await db.query('INSERT INTO users (email, password, name) VALUES ($1, $2, $3) RETURNING id', [email, hash, name.trim()]);
      return reply.code(201).send({ success: true, id: res.rows[0].id });
    } catch (e) {
      return reply.code(409).send({ error: 'Email exists' });
    }
  });

  fastify.post('/api/auth/login', async (request, reply) => {
    const { email, password } = request.body;
    if (!email || !password) {
      return reply.code(400).send({ error: 'E-posta ve şifre zorunludur.' });
    }
    const res = await db.query('SELECT id, password, name FROM users WHERE email = $1', [email]);
    if (!res.rows[0] || !(await bcrypt.compare(password, res.rows[0].password))) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db.query('INSERT INTO sessions (token, user_id, expires) VALUES ($1, $2, $3)', [token, res.rows[0].id, expires]);

    reply.setCookie('session_token', token, { path: '/', httpOnly: true, expires });
    return { success: true, email, name: res.rows[0].name };
  });

  fastify.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies.session_token;
    if (token) await db.query('DELETE FROM sessions WHERE token = $1', [token]);
    reply.clearCookie('session_token', { path: '/' });
    return { success: true };
  });
};
