const { Hono } = require('hono');
const { requireUser } = require('./auth');
const db = require('./db');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const upload = new Hono();
upload.use('*', requireUser);

const ALLOWED_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/ogg': 'ogv',
};

const MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

function getUploadsDir() {
  return path.resolve(
    process.env.UPLOADS_DIR ||
    path.join(__dirname, '..', 'data', 'uploads')
  );
}

/**
 * Extracts all filenames referenced via /uploads/<filename> from a board state or raw buffer
 */
function extractUploadFilenames(data) {
  if (!data) return new Set();
  const raw = typeof data === 'string'
    ? data
    : (data instanceof Uint8Array || ArrayBuffer.isView(data) || Buffer.isBuffer(data))
      ? Buffer.from(data).toString('utf8')
      : String(data);
  const filenames = new Set();
  const matches = raw.matchAll(/\/uploads\/([^"'\s\\?#]+)/g);
  for (const m of matches) {
    if (m[1]) filenames.add(m[1]);
  }
  return filenames;
}

/**
 * Server-side automatic cleanup:
 * Compares old state vs new state of a board. Any files removed from this board
 * are checked across all other boards. If not referenced anywhere, they are deleted from disk.
 */
async function cleanupRemovedUploads(oldData, newData, currentProjectId) {
  const isNode = typeof process !== 'undefined' && process.versions?.node;
  if (!isNode) return;

  const oldFiles = extractUploadFilenames(oldData);
  if (oldFiles.size === 0) return;

  const newFiles = extractUploadFilenames(newData);
  const removedFiles = [];
  for (const file of oldFiles) {
    if (!newFiles.has(file)) {
      removedFiles.push(file);
    }
  }

  if (removedFiles.length === 0) return;

  const uploadsDir = getUploadsDir();

  // Query other boards to see if removed files are still used elsewhere
  let query = 'SELECT doc_data FROM board_docs';
  const params = [];
  if (currentProjectId) {
    query += ' WHERE project_id != $1';
    params.push(currentProjectId);
  }

  try {
    const otherDocs = await db.query(query, params);
    const otherFiles = new Set();
    for (const row of otherDocs.rows || []) {
      const fSet = extractUploadFilenames(row.doc_data);
      for (const f of fSet) otherFiles.add(f);
    }
    // Also include files currently in new state
    for (const f of newFiles) otherFiles.add(f);

    for (const filename of removedFiles) {
      if (!otherFiles.has(filename)) {
        if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) continue;
        const filepath = path.join(uploadsDir, filename);
        if (fs.existsSync(filepath)) {
          try {
            fs.unlinkSync(filepath);
            console.info(`[upload] Auto-deleted unreferenced file: ${filename}`);
          } catch (err) {
            console.warn(`[upload] Failed to delete file ${filename}:`, err.message);
          }
        }
      } else {
        console.info(`[upload] File ${filename} still referenced in another project, preserving.`);
      }
    }
  } catch (err) {
    console.error('[upload] Error during automatic cleanup:', err);
  }
}

// POST /api/upload
upload.post('/', async (c) => {
  const isNode = typeof process !== 'undefined' && process.versions?.node;
  if (!isNode) {
    return c.json({ error: 'Dosya yükleme yalnızca kendi sunucunuzda desteklenmektedir.' }, 501);
  }

  try {
    const formData = await c.req.formData();
    const file = formData.get('file');

    if (!file || typeof file === 'string') {
      return c.json({ error: 'Dosya bulunamadı.' }, 400);
    }

    const mimeType = file.type || '';
    const ext = ALLOWED_TYPES[mimeType];
    if (!ext) {
      return c.json({ error: `Desteklenmeyen dosya türü: ${mimeType}` }, 415);
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.length > MAX_SIZE_BYTES) {
      return c.json({ error: `Dosya çok büyük. Maksimum boyut: ${MAX_SIZE_BYTES / 1024 / 1024} MB` }, 413);
    }

    const uploadsDir = getUploadsDir();
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const filename = `${crypto.randomUUID()}.${ext}`;
    const filepath = path.join(uploadsDir, filename);
    fs.writeFileSync(filepath, buffer);

    const url = `/uploads/${filename}`;
    console.info(`[upload] Saved ${mimeType} ${buffer.length} bytes → ${url}`);

    return c.json({ url, size: buffer.length, type: mimeType });
  } catch (err) {
    console.error('[upload] Error:', err);
    return c.json({ error: 'Dosya yüklenemedi: ' + err.message }, 500);
  }
});

module.exports = {
  upload,
  extractUploadFilenames,
  cleanupRemovedUploads,
  getUploadsDir
};
