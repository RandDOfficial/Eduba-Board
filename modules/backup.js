const fs = require('fs');
const path = require('path');
const db = require('./db');

// Read environment variables or set fallbacks (48 hours, 5 backups)
const BACKUP_INTERVAL_HOURS = parseInt(process.env.BACKUP_INTERVAL_HOURS || '48', 10);
const MAX_BACKUPS = parseInt(process.env.MAX_BACKUPS || '5', 10);

const defaultDir = process.env.NODE_ENV === 'production'
  ? path.join(__dirname, '..', 'data', 'backups')
  : path.join(__dirname, '..', 'backups');

const backupsDir = process.env.DB_PATH
  ? path.join(path.dirname(process.env.DB_PATH), 'backups')
  : defaultDir;

function ensureBackupsDir() {
  if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
  }
}

function formatDate(date = new Date()) {
  const pad = num => String(num).padStart(2, '0');
  const YYYY = date.getFullYear();
  const MM = pad(date.getMonth() + 1);
  const DD = pad(date.getDate());
  const HH = pad(date.getHours());
  const mm = pad(date.getMinutes());
  return `${YYYY}.${MM}.${DD}-${HH}.${mm}`;
}

async function performBackup() {
  if (db.isPostgres) {
    return;
  }

  try {
    ensureBackupsDir();
    const filename = `${formatDate()}.sqlite3`;
    const destPath = path.join(backupsDir, filename);

    if (db.sqlite) {
      if (typeof db.sqlite.backup === 'function') {
        await db.sqlite.backup(destPath);
      } else {
        const sourcePath = process.env.DB_PATH || (process.env.NODE_ENV === 'production' ? path.join(__dirname, '..', 'data', 'sqlite.db') : path.join(__dirname, '..', 'sqlite.db'));
        if (fs.existsSync(sourcePath)) {
          fs.copyFileSync(sourcePath, destPath);
        }
      }
      console.info(`[backup] Veritabanı yedeği alındı: ${filename}`);

      // Clean up old backups if count exceeds MAX_BACKUPS
      rotateBackups();
    }
  } catch (err) {
    console.error('[backup] Yedek alma hatası:', err);
  }
}

function rotateBackups() {
  if (db.isPostgres) return;

  try {
    ensureBackupsDir();
    const files = fs.readdirSync(backupsDir)
      .filter(f => f.endsWith('.sqlite3'))
      .map(f => ({
        name: f,
        path: path.join(backupsDir, f),
        time: fs.statSync(path.join(backupsDir, f)).mtimeMs
      }))
      .sort((a, b) => a.time - b.time); // Oldest first

    if (files.length > MAX_BACKUPS) {
      const toDeleteCount = files.length - MAX_BACKUPS;
      const filesToDelete = files.slice(0, toDeleteCount);

      filesToDelete.forEach(file => {
        try {
          fs.unlinkSync(file.path);
          console.info(`[backup] En eski yedek silindi: ${file.name}`);
        } catch (e) {
          console.error(`[backup] Yedek silinemedi (${file.name}):`, e);
        }
      });
    }
  } catch (err) {
    console.error('[backup] Rotasyon hatası:', err);
  }
}

function init() {
  if (db.isPostgres) {
    console.info('[backup] PostgreSQL veritabanı aktif (Yedeklemeler harici pg_dump / DB snapshot ile yönetilir).');
    return;
  }

  console.info(`[backup] SQLite yedekleme servisi başlatıldı (Sıklık: ${BACKUP_INTERVAL_HOURS} saat, Max Limit: ${MAX_BACKUPS} yedek)`);
  
  // Initial backup on startup
  performBackup();

  // Schedule periodic backup
  const intervalMs = BACKUP_INTERVAL_HOURS * 60 * 60 * 1000;
  const backupTimer = setInterval(() => {
    performBackup();
  }, intervalMs);
  backupTimer.unref();
}

module.exports = {
  init,
  performBackup,
  rotateBackups
};
