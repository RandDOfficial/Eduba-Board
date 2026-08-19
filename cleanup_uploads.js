/**
 * cleanup_uploads.js
 * Deletes all files in data/uploads that are not referenced in any board_docs.
 * Run: node cleanup_uploads.js
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DB_PATH    = process.env.DB_PATH    || path.join(__dirname, 'data', 'sqlite.db');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'data', 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  console.log('Uploads directory not found:', UPLOADS_DIR);
  process.exit(0);
}

const db = new DatabaseSync(DB_PATH);
const rows = db.prepare('SELECT doc_data FROM board_docs').all();

// Build a set of all /uploads/ filenames referenced in any board state
const referenced = new Set();
for (const row of rows) {
  try {
    const raw = Buffer.from(row.doc_data).toString('utf8');
    // Exclude backslash too — JSON stores HTML attrs as \"...\" so after filename comes \"
    const matches = raw.matchAll(/\/uploads\/([^"'\s\\]+)/g);
    for (const m of matches) referenced.add(m[1]);
  } catch {}
}

console.log(`Referenced files in DB: ${referenced.size}`);
if (referenced.size > 0) {
  console.log([...referenced].map(f => '  ' + f).join('\n'));
}

const files = fs.readdirSync(UPLOADS_DIR);
console.log(`\nTotal files in uploads: ${files.length}`);

let deleted = 0;
let kept = 0;
for (const file of files) {
  if (referenced.has(file)) {
    console.log(`  ✅ Keep: ${file}`);
    kept++;
  } else {
    fs.unlinkSync(path.join(UPLOADS_DIR, file));
    console.log(`  🗑️  Deleted orphan: ${file}`);
    deleted++;
  }
}

console.log(`\nDone! Deleted: ${deleted}, Kept: ${kept}`);
