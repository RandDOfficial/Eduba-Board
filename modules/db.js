const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const isPostgres = Boolean(databaseUrl || process.env.DB_TYPE === 'postgres');

let sqlite = null;
let pgPool = null;

if (isPostgres) {
  const { Pool } = require('pg');
  const poolConfig = {
    connectionString: databaseUrl || `postgres://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || ''}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'eduba'}`
  };

  if (process.env.DB_SSL === 'true' || (process.env.NODE_ENV === 'production' && databaseUrl?.includes('sslmode=require'))) {
    poolConfig.ssl = { rejectUnauthorized: false };
  }

  pgPool = new Pool(poolConfig);
  pgPool.on('error', (err) => {
    console.error('[db] PostgreSQL pool error:', err);
  });
} else {
  const Database = require('better-sqlite3');
  const defaultPath = process.env.NODE_ENV === 'production'
    ? path.join(__dirname, '..', 'data', 'sqlite.db')
    : path.join(__dirname, '..', 'sqlite.db');

  let dbPath = process.env.DB_PATH || defaultPath;

  // Handle edge case where Docker mounted a directory instead of a file
  if (fs.existsSync(dbPath) && fs.statSync(dbPath).isDirectory()) {
    dbPath = path.join(dbPath, 'sqlite.db');
  }

  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  sqlite = new Database(dbPath);
  sqlite.pragma('foreign_keys = ON');

  // Register Postgres compatibility functions in SQLite
  sqlite.function('gen_random_uuid', () => crypto.randomUUID());
  sqlite.function('now', () => new Date().toISOString());
  sqlite.function('btrim', (str) => (str ? String(str).trim() : ''));
  sqlite.function('split_part', (str, delim, pos) => {
    if (!str) return '';
    const parts = String(str).split(delim);
    return parts[pos - 1] || '';
  });
}

async function initSchema(retries = 15, delay = 2000) {
  if (isPostgres) {
    // Retry connecting to PostgreSQL (crucial when booting alongside Postgres in Docker Compose)
    for (let i = 0; i < retries; i++) {
      try {
        console.info(`[db] PostgreSQL bağlantısı kontrol ediliyor (${i + 1}/${retries})...`);
        await pgPool.query('SELECT 1');
        break;
      } catch (err) {
        if (i === retries - 1) {
          console.error('[db] PostgreSQL veritabanına bağlanılamadı:', err.message);
          throw err;
        }
        console.warn(`[db] PostgreSQL henüz hazır değil (${err.message}). ${delay / 1000} saniye içinde tekrar deneniyor...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    console.info('[db] PostgreSQL tabloları oluşturuluyor/doğrulanıyor...');
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT NOT NULL,
        avatar TEXT DEFAULT '',
        created TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        created TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        expires TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        icon TEXT DEFAULT '📁',
        expanded INTEGER DEFAULT 0,
        created TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS group_members (
        group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        role TEXT DEFAULT 'editor',
        expanded INTEGER DEFAULT 0,
        created TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (group_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT 'Untitled',
        group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
        owner_id TEXT REFERENCES users(id) NOT NULL,
        icon TEXT DEFAULT '📝',
        created TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS board_docs (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        doc_data BYTEA NOT NULL,
        updated TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY,
        group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        created TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(group_id, email)
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
      CREATE INDEX IF NOT EXISTS idx_group_members_user_id ON group_members(user_id);
      CREATE INDEX IF NOT EXISTS idx_group_members_group_id ON group_members(group_id);
      CREATE INDEX IF NOT EXISTS idx_projects_owner_id ON projects(owner_id);
      CREATE INDEX IF NOT EXISTS idx_projects_group_id ON projects(group_id);
      CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(email);

      DELETE FROM sessions WHERE expires <= CURRENT_TIMESTAMP;
    `);
    console.info('[db] PostgreSQL veritabanı hazır.');
  } else {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT NOT NULL,
        avatar TEXT DEFAULT '',
        created TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        created TEXT DEFAULT CURRENT_TIMESTAMP,
        expires TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        icon TEXT DEFAULT '📁',
        expanded INTEGER DEFAULT 0,
        created TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS group_members (
        group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        role TEXT DEFAULT 'editor',
        expanded INTEGER DEFAULT 0,
        created TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (group_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT 'Untitled',
        group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
        owner_id TEXT REFERENCES users(id) NOT NULL,
        icon TEXT DEFAULT '📝',
        created TEXT DEFAULT CURRENT_TIMESTAMP,
        updated TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS board_docs (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        doc_data BLOB NOT NULL,
        updated TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY,
        group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        created TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(group_id, email)
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
      CREATE INDEX IF NOT EXISTS idx_group_members_user_id ON group_members(user_id);
      CREATE INDEX IF NOT EXISTS idx_group_members_group_id ON group_members(group_id);
      CREATE INDEX IF NOT EXISTS idx_projects_owner_id ON projects(owner_id);
      CREATE INDEX IF NOT EXISTS idx_projects_group_id ON projects(group_id);
      CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(email);

      DELETE FROM sessions WHERE expires <= datetime('now');
      DELETE FROM groups WHERE id NOT IN (SELECT DISTINCT group_id FROM group_members WHERE role = 'owner');
    `);
  }
}

// Ensure schema is created on startup
initSchema().catch(err => {
  console.error('[db] Şema başlatma hatası:', err);
});

function normalizeParams(params = []) {
  return params.map(p => {
    if (p instanceof Date) return p.toISOString();
    if (typeof p === 'boolean') return isPostgres ? p : (p ? 1 : 0);
    if (p === undefined) return null;
    return p;
  });
}

function prepareInsertQuery(sql, params) {
  const match = sql.match(/^INSERT\s+INTO\s+([a-z_]+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)(.*)$/i);
  if (match) {
    const table = match[1].toLowerCase();
    const cols = match[2].split(',').map(c => c.trim().toLowerCase());
    const tablesWithId = ['users', 'groups', 'projects', 'invitations'];

    if (tablesWithId.includes(table) && !cols.includes('id')) {
      const newCols = 'id, ' + match[2];
      const newId = crypto.randomUUID();
      const shiftedValues = match[3].replace(/\$(\d+)/g, (_, n) => '$' + (parseInt(n, 10) + 1));
      const newValues = '$1, ' + shiftedValues;
      const rest = match[4];
      const newSql = `INSERT INTO ${table} (${newCols}) VALUES (${newValues})${rest}`;
      const newParams = [newId, ...params];
      return { sql: newSql, params: newParams };
    }
  }
  return { sql, params };
}

function transformQueryAndParams(sql, params) {
  const norm = normalizeParams(params);
  const cleanParams = [];
  const transformedSql = sql.replace(/\$(\d+)/g, (_, num) => {
    const idx = parseInt(num, 10) - 1;
    cleanParams.push(norm[idx]);
    return '?';
  });
  return { sql: transformedSql, params: cleanParams };
}

async function query(text, params = []) {
  const trimmedText = text.trim();
  const prep = prepareInsertQuery(trimmedText, params);

  if (isPostgres) {
    const norm = normalizeParams(prep.params);
    const res = await pgPool.query(prep.sql, norm);
    return {
      rows: res.rows,
      rowCount: res.rowCount,
      changes: res.rowCount
    };
  }

  return new Promise((resolve, reject) => {
    try {
      const { sql, params: cleanParams } = transformQueryAndParams(prep.sql, prep.params);
      const stmt = sqlite.prepare(sql);

      const isSelect = /^(SELECT|WITH|PRAGMA)/i.test(sql);
      const hasReturning = /RETURNING/i.test(sql);

      if (isSelect || hasReturning) {
        const rows = stmt.all(...cleanParams);
        resolve({ rows, rowCount: rows.length });
      } else {
        const info = stmt.run(...cleanParams);
        resolve({ rows: [], rowCount: info.changes, changes: info.changes, lastInsertRowid: info.lastInsertRowid });
      }
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  sqlite,
  pgPool,
  isPostgres,
  query,
  initSchema,
};
