// db.js — SQLite + WAL + safe migrations (unix time)

const sqlite3 = require("sqlite3").verbose();

const DB_PATH = process.env.SQLITE_PATH || "/var/data/database.sqlite";
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA synchronous = NORMAL;");
  db.run("PRAGMA foreign_keys = ON;");
  db.run("PRAGMA busy_timeout = 8000;");

  // ---------------- scheduled_messages ----------------
  db.run(`
    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      send_time INTEGER NOT NULL,
      message TEXT NOT NULL,

      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      sent_at INTEGER,
      error TEXT,
      last_error TEXT,

      template_id INTEGER,
      template_key TEXT,
      rule_key TEXT,
      step INTEGER,
      meta TEXT,

      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,

      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    )
  `);

  // ---------------- migrate legacy TEXT send_time ----------------
  db.all("PRAGMA table_info(scheduled_messages)", (err, rows) => {
    if (err || !rows) return;

    const sendTimeCol = rows.find((r) => r.name === "send_time");

    if (sendTimeCol && sendTimeCol.type === "TEXT") {
      console.log("🔁 Migrating scheduled_messages.send_time → unix millis");

      db.serialize(() => {
        db.run("ALTER TABLE scheduled_messages RENAME TO _sched_old");

        db.run(`
          CREATE TABLE scheduled_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            client_id INTEGER NOT NULL,
            send_time INTEGER NOT NULL,
            message TEXT NOT NULL,
            status TEXT NOT NULL,
            attempts INTEGER NOT NULL,
            sent_at INTEGER,
            error TEXT,
            last_error TEXT,
            template_id INTEGER,
            template_key TEXT,
            rule_key TEXT,
            step INTEGER,
            meta TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `);

        db.run(`
          INSERT INTO scheduled_messages
          SELECT
            id,
            client_id,
            CAST(strftime('%s', send_time) AS INTEGER) * 1000,
            message,
            status,
            attempts,
            CASE WHEN sent_at IS NOT NULL THEN CAST(strftime('%s', sent_at) AS INTEGER) * 1000 END,
            error,
            last_error,
            template_id,
            template_key,
            rule_key,
            step,
            meta,
            CAST(strftime('%s', created_at) AS INTEGER) * 1000,
            CAST(strftime('%s', updated_at) AS INTEGER) * 1000
          FROM _sched_old
        `);

        db.run("DROP TABLE _sched_old");
        console.log("✅ Migration complete");
      });
    }
  });
});

module.exports = db;
