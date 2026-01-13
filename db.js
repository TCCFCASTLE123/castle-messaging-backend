// db.js — CLEAN, STABLE, BOOT-PROOF
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

// SQLite file (use Render Disk later if you want persistence)
const DB_PATH = path.join(__dirname, "database.sqlite");

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error("❌ SQLite connection failed:", err.message);
  } else {
    console.log("✅ SQLite connected:", DB_PATH);
  }
});

db.serialize(() => {
  /* =========================
     CLIENTS
  ========================= */
  db.run(`
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      notes TEXT,
      language TEXT
    )
  `);

  /* =========================
     MESSAGES (Twilio-critical)
  ========================= */
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER,
      sender TEXT NOT NULL,
      text TEXT NOT NULL,
      direction TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      external_id TEXT,
      FOREIGN KEY (client_id) REFERENCES clients(id)
    )
  `);

  /* =========================
     USERS / AUTH
  ========================= */
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'admin'
    )
  `);

  /* =========================
     STATUSES
  ========================= */
  db.run(`
    CREATE TABLE IF NOT EXISTS statuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    )
  `);

  db.run(`INSERT OR IGNORE INTO statuses (name) VALUES ('new')`);
  db.run(`INSERT OR IGNORE INTO statuses (name) VALUES ('active')`);
  db.run(`INSERT OR IGNORE INTO statuses (name) VALUES ('closed')`);

  /* =========================
     TEMPLATES
  ========================= */
  db.run(`
    CREATE TABLE IF NOT EXISTS templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      body TEXT NOT NULL
    )
  `);

  /* =========================
     SCHEDULED MESSAGES
  ========================= */
  db.run(`
    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER,
      message TEXT,
      send_at DATETIME,
      sent INTEGER DEFAULT 0,
      FOREIGN KEY (client_id) REFERENCES clients(id)
    )
  `);

  /* =========================
     OPTIONAL: LOG SCHEMA
     (helps confirm Render is using THIS file)
  ========================= */
  db.all("PRAGMA table_info(clients)", (err, rows) => {
    if (!err && rows) {
      console.log("📦 clients columns:", rows.map(r => r.name).join(", "));
    }
  });

  db.all("PRAGMA table_info(messages)", (err, rows) => {
    if (!err && rows) {
      console.log("📦 messages columns:", rows.map(r => r.name).join(", "));
    }
  });
});

module.exports = db;
