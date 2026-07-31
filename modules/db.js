const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

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

const sqlite = new Database(dbPath);

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

function initSchema() {
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
      UNIQUE(group_id, email)
    );

    -- High performance database indexes
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
    CREATE INDEX IF NOT EXISTS idx_group_members_user_id ON group_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_group_members_group_id ON group_members(group_id);
    CREATE INDEX IF NOT EXISTS idx_projects_owner_id ON projects(owner_id);
    CREATE INDEX IF NOT EXISTS idx_projects_group_id ON projects(group_id);
    CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(email);

    -- Clean up expired sessions
    DELETE FROM sessions WHERE expires <= datetime('now');

    -- Delete any orphaned groups that do not have an active owner member
    DELETE FROM groups WHERE id NOT IN (SELECT DISTINCT group_id FROM group_members WHERE role = 'owner');
  `);
}

// Automatically ensure tables are created and cleaned up
initSchema();

function normalizeParams(params = []) {
  return params.map(p => {
    if (p instanceof Date) return p.toISOString();
    if (typeof p === 'boolean') return p ? 1 : 0;
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

function query(text, params = []) {
  return new Promise((resolve, reject) => {
    try {
      const trimmedText = text.trim();
      const prep = prepareInsertQuery(trimmedText, params);
      const { sql, params: cleanParams } = transformQueryAndParams(prep.sql, prep.params);
      const stmt = sqlite.prepare(sql);

      const isSelect = /^(SELECT|WITH|PRAGMA)/i.test(sql);
      const hasReturning = /RETURNING/i.test(sql);

      if (isSelect || hasReturning) {
        const rows = stmt.all(...cleanParams);
        resolve({ rows });
      } else {
        const info = stmt.run(...cleanParams);
        resolve({ rows: [], changes: info.changes, lastInsertRowid: info.lastInsertRowid });
      }
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  sqlite,
  query,
  initSchema,
};
