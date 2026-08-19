const { Hono } = require('hono');
const { requireUser } = require('./auth');

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

upload.post('/', async (c) => {
  // Only available in Node environment (not Cloudflare Workers)
  const isNode = typeof process !== 'undefined' && process.versions?.node;
  if (!isNode) {
    return c.json({ error: 'Dosya yükleme yalnızca kendi sunucunuzda desteklenmektedir.' }, 501);
  }

  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');

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

    // Resolve uploads directory:
    // - Docker/production: /app/data/uploads (inside volume)
    // - Local dev: ./data/uploads
    const uploadsDir = path.resolve(
      process.env.UPLOADS_DIR ||
      path.join(__dirname, '..', 'data', 'uploads')
    );

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

// DELETE /api/upload?url=/uploads/xxx.mp4
// Deletes the file only if it's not referenced in any board_docs
upload.delete('/', async (c) => {
  const isNode = typeof process !== 'undefined' && process.versions?.node;
  if (!isNode) return c.json({ deleted: false });

  const fs = require('fs');
  const path = require('path');
  const db = require('./db');

  try {
    const fileUrl = c.req.query('url'); // e.g. /uploads/abc.mp4
    if (!fileUrl || !fileUrl.startsWith('/uploads/')) {
      return c.json({ error: 'Geçersiz URL.' }, 400);
    }

    const filename = path.basename(fileUrl);
    // Safety: prevent path traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return c.json({ error: 'Geçersiz dosya adı.' }, 400);
    }

    // Check if this URL is still referenced in any board_docs
    const allDocs = await db.query('SELECT doc_data FROM board_docs');
    const isReferenced = (allDocs.rows || []).some(row => {
      try {
        const raw = Buffer.isBuffer(row.doc_data)
          ? row.doc_data.toString('utf8')
          : (row.doc_data instanceof Uint8Array || ArrayBuffer.isView(row.doc_data))
            ? Buffer.from(row.doc_data).toString('utf8')
            : String(row.doc_data);
        return raw.includes(fileUrl);
      } catch { return false; }
    });

    if (isReferenced) {
      console.info(`[upload] File still referenced, not deleting: ${filename}`);
      return c.json({ deleted: false, reason: 'still_referenced' });
    }

    const uploadsDir = path.resolve(
      process.env.UPLOADS_DIR ||
      path.join(__dirname, '..', 'data', 'uploads')
    );
    const filepath = path.join(uploadsDir, filename);

    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
      console.info(`[upload] Deleted orphan file: ${filename}`);
      return c.json({ deleted: true });
    }

    return c.json({ deleted: false, reason: 'not_found' });
  } catch (err) {
    console.error('[upload] Delete error:', err);
    return c.json({ error: err.message }, 500);
  }
});

module.exports = { upload };
