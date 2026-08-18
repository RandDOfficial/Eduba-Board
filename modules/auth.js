const { Hono } = require('hono');
const { getCookie, setCookie, deleteCookie } = require('hono/cookie');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('./db');

const auth = new Hono();

// Validation helpers
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const isValidName = (name) => typeof name === 'string' && name.trim().length >= 2 && name.trim().length <= 40;

// Auth helper function to extract user from session
async function getUserFromSession(c) {
  const token = getCookie(c, 'session_token');
  if (!token) return null;

  try {
    const nowIso = new Date().toISOString();
    const res = await db.query(
      'SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = $1 AND s.expires > $2',
      [token, nowIso]
    );
    return res.rows[0] || null;
  } catch (err) {
    console.error('[auth] getUserFromSession error:', err);
    return null;
  }
}

// Require user middleware
async function requireUser(c, next) {
  const user = await getUserFromSession(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  c.set('user', user);
  await next();
}

auth.post('/register', async (c) => {
  const allowRegistration = process.env.ALLOW_REGISTRATION !== 'false';
  if (!allowRegistration) {
    return c.json({ error: 'Yeni kullanıcı kayıtları yönetici tarafından kapatılmıştır.' }, 403);
  }

  const { email, password, name } = await c.req.json().catch(() => ({}));
  if (!isValidName(name)) {
    return c.json({ error: 'Kullanıcı adı 2-40 karakter arasında olmalıdır.' }, 400);
  }
  if (!email || !password || password.length < 6) {
    return c.json({ error: 'Geçersiz e-posta veya kısa şifre (en az 6 karakter olmalı).' }, 400);
  }
  if (!isValidEmail(email)) {
    return c.json({ error: 'Lütfen geçerli bir e-posta adresi girin.' }, 400);
  }

  const hash = await bcrypt.hash(password, 10);
  try {
    const res = await db.query(
      'INSERT INTO users (email, password, name) VALUES ($1, $2, $3) RETURNING id',
      [email.toLowerCase().trim(), hash, name.trim()]
    );
    return c.json({ success: true, id: res.rows[0].id }, 201);
  } catch (e) {
    console.error('[auth] Kayıt hatası:', e);
    if (e.code === '23505' || e.message?.includes('UNIQUE') || e.message?.includes('constraint failed')) {
      return c.json({ error: 'Bu e-posta adresi ile zaten kayıtlı bir hesap var.' }, 409);
    }
    return c.json({ error: 'Kayıt sırasında bir sunucu hatası oluştu: ' + (e.message || 'Veritabanı hatası') }, 500);
  }
});

auth.post('/login', async (c) => {
  const { email, password } = await c.req.json().catch(() => ({}));
  if (!email || !password) {
    return c.json({ error: 'E-posta ve şifre zorunludur.' }, 400);
  }

  try {
    const res = await db.query('SELECT id, password, name FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (!res.rows[0] || !(await bcrypt.compare(password, res.rows[0].password))) {
      return c.json({ error: 'E-posta veya şifre hatalı.' }, 401);
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db.query('INSERT INTO sessions (token, user_id, expires) VALUES ($1, $2, $3)', [token, res.rows[0].id, expires.toISOString()]);

    setCookie(c, 'session_token', token, {
      path: '/',
      httpOnly: true,
      expires,
      sameSite: 'Lax'
    });

    return c.json({ success: true, email: email.toLowerCase().trim(), name: res.rows[0].name });
  } catch (err) {
    console.error('[auth] Giriş hatası:', err);
    return c.json({ error: 'Giriş sırasında sunucu hatası: ' + (err.message || 'Veritabanı hatası') }, 500);
  }
});

auth.post('/logout', async (c) => {
  const token = getCookie(c, 'session_token');
  if (token) {
    await db.query('DELETE FROM sessions WHERE token = $1', [token]).catch(() => {});
  }
  deleteCookie(c, 'session_token', { path: '/' });
  return c.json({ success: true });
});

module.exports = {
  auth,
  requireUser,
  getUserFromSession
};
