const db = require('./modules/db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

async function run() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === 'register') {
    const [email, password, name] = args.slice(1);
    if (!email || !password || !name || name.trim().length < 2 || name.trim().length > 40) {
      console.error('Usage: node cli.js register <email> <password> <username>');
      process.exit(1);
    }
    const hash = await bcrypt.hash(password, 10);
    await db.query('INSERT INTO users (email, password, name) VALUES ($1, $2, $3)', [email, hash, name.trim()]);
    console.log("User registered.");
  } else if (cmd === 'login') {
    const [email, password] = args.slice(1);
    const res = await db.query('SELECT id, password FROM users WHERE email = $1', [email]);
    if (res.rows[0] && await bcrypt.compare(password, res.rows[0].password)) {
      const token = crypto.randomBytes(32).toString('hex');
      const exp = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await db.query('INSERT INTO sessions (token, user_id, expires) VALUES ($1, $2, $3)', [token, res.rows[0].id, exp]);
      console.log('Success. Token: ' + token);
    } else {
      console.log("Invalid credentials");
    }
  }
  process.exit(0);
}
run();
