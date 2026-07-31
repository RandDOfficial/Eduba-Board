const db = require('./modules/db');

async function run() {
  console.log("Initializing local SQLite database schema...");
  db.initSchema();
  console.log("Tables created successfully.");
}

run().catch(console.error);
