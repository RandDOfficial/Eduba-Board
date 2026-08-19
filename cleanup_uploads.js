/**
 * cleanup_uploads.js
 * Deletes all files in data/uploads that are not referenced in any board_docs.
 * Run: node cleanup_uploads.js
 */
const fs = require('fs');
const path = require('path');
const { extractUploadFilenames, getUploadsDir } = require('./modules/upload');
const db = require('./modules/db');

async function runCleanup() {
  const uploadsDir = getUploadsDir();

  if (!fs.existsSync(uploadsDir)) {
    console.log('Uploads directory not found:', uploadsDir);
    process.exit(0);
  }

  const { rows } = await db.query('SELECT doc_data FROM board_docs');

  // Build a set of all /uploads/ filenames referenced in any board state
  const referenced = new Set();
  for (const row of rows || []) {
    const fSet = extractUploadFilenames(row.doc_data);
    for (const f of fSet) referenced.add(f);
  }

  console.log(`Referenced files in DB: ${referenced.size}`);
  if (referenced.size > 0) {
    console.log([...referenced].map(f => '  ' + f).join('\n'));
  }

  const files = fs.readdirSync(uploadsDir);
  console.log(`\nTotal files on disk: ${files.length}`);

  let deleted = 0;
  let kept = 0;
  for (const file of files) {
    if (referenced.has(file)) {
      console.log(`  ✅ Keep: ${file}`);
      kept++;
    } else {
      try {
        fs.unlinkSync(path.join(uploadsDir, file));
        console.log(`  🗑️  Deleted orphan: ${file}`);
        deleted++;
      } catch (e) {
        console.warn(`  ⚠️  Failed to delete ${file}:`, e.message);
      }
    }
  }

  console.log(`\nDone! Deleted: ${deleted}, Kept: ${kept}`);
  process.exit(0);
}

runCleanup().catch(err => {
  console.error('Cleanup error:', err);
  process.exit(1);
});
