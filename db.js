// db.js — CLEAN + RENDER DISK + WAL MODE (prevents hangs/locks)

const sqlite3 = require("sqlite3").verbose();

const DB_PATH = process.env.SQLITE_PATH || "/var/data/database.sqlite";

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error("❌ SQLite connection failed:", err.message);
  else console.log("✅ SQLite connected:", DB_PATH);
});

db.serialize(() => {
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA synchronous = NORMAL;");
  db.run("PRAGMA foreign_keys = ON;");
  db.run("PRAGMA busy_timeout = 8000;");

  db.run(`
    CREATE TABLE IF NOT EXISTS statuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    )
  `);

  const statuses = [
    "Set",
    "Working To Set",
    "Showed",
    "No Show",
    "Can't Help",
    "Attempted/Unsuccessful",
    "Pending",
    "Retained",
    "No Money",
    "Seen Can't Help",
    "Did Not Retain",
    "Referred Out",
  ];

  statuses.forEach((s) => {
    db.run(`INSERT OR IGNORE INTO statuses (name) VALUES (?)`, [s]);
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      email TEXT,
      notes TEXT,
      language TEXT DEFAULT 'English',
      office TEXT,
      case_type TEXT,
      appointment_datetime TEXT,
      status_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_message_at TEXT,
      last_message_text TEXT,
      FOREIGN KEY (status_id) REFERENCES statuses(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      sender TEXT NOT NULL,
      text TEXT NOT NULL,
      direction TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      external_id TEXT,
      FOREIGN KEY (client_id) REFERENCES clients(id)
    )
  `);

  // ✅ Safe “add column if missing” for older DBs (Render disk keeps old schema)
  db.all("PRAGMA table_info(clients)", (err, rows) => {
    if (err || !rows) return;

    const names = new Set(rows.map((r) => r.name));
    const addCol = (name, type) => {
      if (names.has(name)) return;
      db.run(`ALTER TABLE clients ADD COLUMN ${name} ${type}`, (e) => {
        if (e) console.error(`❌ ALTER clients add ${name} failed:`, e.message);
        else console.log(`✅ Added clients.${name}`);
      });
    };

    addCol("last_message_at", "TEXT");
    addCol("last_message_text", "TEXT");
  });

  db.all("PRAGMA table_info(clients)", (err, rows) => {
    if (!err && rows) console.log("📦 clients columns:", rows.map((r) => r.name).join(", "));
  });

  db.all("PRAGMA table_info(messages)", (err, rows) => {
    if (!err && rows) console.log("📦 messages columns:", rows.map((r) => r.name).join(", "));
  });
});

module.exports = db;
