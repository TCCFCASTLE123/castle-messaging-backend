// db.js — CLEAN + RENDER DISK + WAL MODE (prevents hangs/locks)

const sqlite3 = require("sqlite3").verbose();

const DB_PATH = process.env.SQLITE_PATH || "/var/data/database.sqlite";

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error("❌ SQLite connection failed:", err.message);
  else console.log("✅ SQLite connected:", DB_PATH);
});

db.serialize(() => {
  // Prevent "database is locked" issues that look like pending requests
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA synchronous = NORMAL;");
  db.run("PRAGMA foreign_keys = ON;");
  db.run("PRAGMA busy_timeout = 8000;");

  /* =========================
     USERS (NEW)
     - username UNIQUE
     - password_hash (bcrypt)
     - role: admin | user
  ========================= */
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`);

  /* =========================
     STATUSES
  ========================= */
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

  /* =========================
     CLIENTS
     - phone is UNIQUE (fixes ON CONFLICT issues)
     - includes status_id, office, case_type, appointment_datetime
  ========================= */
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
      FOREIGN KEY (status_id) REFERENCES statuses(id)
    )
  `);

  /* =========================
     MESSAGES
  ========================= */
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

  // Helpful boot logs
  db.all("PRAGMA table_info(users)", (err, rows) => {
    if (!err && rows) {
      console.log("📦 users columns:", rows.map((r) => r.name).join(", "));
    }
  });

  db.all("PRAGMA table_info(clients)", (err, rows) => {
    if (!err && rows) {
      console.log("📦 clients columns:", rows.map((r) => r.name).join(", "));
    }
  });

  db.all("PRAGMA table_info(messages)", (err, rows) => {
    if (!err && rows) {
      console.log("📦 messages columns:", rows.map((r) => r.name).join(", "));
    }
  });
});

module.exports = db;
