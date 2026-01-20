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
    "No Longer Needs Assistance",
  ];

  statuses.forEach((s) => {
    db.run(`INSERT OR IGNORE INTO statuses (name) VALUES (?)`, [s]);
  });

  // ✅ Templates (rules/steps)
  db.run(`
    CREATE TABLE IF NOT EXISTS templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT,
      office TEXT,
      case_type TEXT,
      appointment_type TEXT,
      language TEXT,
      delay_hours INTEGER DEFAULT 0,
      template TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      attorney_assigned TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // ✅ Clients
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

  // ✅ Messages
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

  // ✅ Scheduled messages queue (used for automated follow-ups)
  db.run(`
    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      send_time TEXT NOT NULL,
      message TEXT NOT NULL,

      status TEXT NOT NULL DEFAULT 'pending',  -- pending | sending | sent | failed | canceled
      attempts INTEGER NOT NULL DEFAULT 0,
      sent_at TEXT,
      error TEXT,
      last_error TEXT,

      template_id INTEGER,
      template_key TEXT,
      rule_key TEXT,
      step INTEGER,
      meta TEXT,

      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),

      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    )
  `);

  // ✅ indexes (safe even if already exist)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_sched_client_time
    ON scheduled_messages(client_id, send_time)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_sched_status_time
    ON scheduled_messages(status, send_time)
  `);

  // Prevent duplicate scheduling for same client+template+time
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sched_unique_client_template_time
    ON scheduled_messages(client_id, template_id, send_time)
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

    addCol("appt_date", "TEXT");
    addCol("appt_time", "TEXT");
    addCol("appt_setter", "TEXT");

    addCol("ic", "TEXT");
    addCol("intake_coordinator", "TEXT"); // ✅ you use this in webhook
    addCol("case_group", "TEXT");         // ✅ webhook sends case_group
    addCol("case_subtype", "TEXT");

    addCol("attorney_assigned", "TEXT");
  });

  // ✅ templates: safe add columns if missing
  db.all("PRAGMA table_info(templates)", (err, rows) => {
    if (err || !rows) return;

    const names = new Set(rows.map((r) => r.name));
    const addCol = (name, type) => {
      if (names.has(name)) return;
      db.run(`ALTER TABLE templates ADD COLUMN ${name} ${type}`, (e) => {
        if (e) console.error(`❌ ALTER templates add ${name} failed:`, e.message);
        else console.log(`✅ Added templates.${name}`);
      });
    };

    addCol("attorney_assigned", "TEXT");
  });

  // ✅ scheduled_messages: safe add columns if missing
  db.all("PRAGMA table_info(scheduled_messages)", (err, rows) => {
    if (err || !rows) return;

    const names = new Set(rows.map((r) => r.name));
    const addCol = (name, type) => {
      if (names.has(name)) return;
      db.run(`ALTER TABLE scheduled_messages ADD COLUMN ${name} ${type}`, (e) => {
        if (e) console.error(`❌ ALTER scheduled_messages add ${name} failed:`, e.message);
        else console.log(`✅ Added scheduled_messages.${name}`);
      });
    };

    addCol("status", "TEXT NOT NULL DEFAULT 'pending'");
    addCol("attempts", "INTEGER NOT NULL DEFAULT 0");
    addCol("sent_at", "TEXT");
    addCol("error", "TEXT");
    addCol("last_error", "TEXT");

    addCol("template_id", "INTEGER");
    addCol("template_key", "TEXT");
    addCol("rule_key", "TEXT");
    addCol("step", "INTEGER");
    addCol("meta", "TEXT");

    addCol("created_at", "TEXT NOT NULL DEFAULT (datetime('now'))");
    addCol("updated_at", "TEXT NOT NULL DEFAULT (datetime('now'))");
  });

  // Debug schema
  db.all("PRAGMA table_info(clients)", (err, rows) => {
    if (!err && rows) console.log("📦 clients columns:", rows.map((r) => r.name).join(", "));
  });

  db.all("PRAGMA table_info(messages)", (err, rows) => {
    if (!err && rows) console.log("📦 messages columns:", rows.map((r) => r.name).join(", "));
  });

  db.all("PRAGMA table_info(templates)", (err, rows) => {
    if (!err && rows) console.log("📦 templates columns:", rows.map((r) => r.name).join(", "));
  });

  db.all("PRAGMA table_info(scheduled_messages)", (err, rows) => {
    if (!err && rows) console.log("📦 scheduled_messages columns:", rows.map((r) => r.name).join(", "));
  });
});

module.exports = db;
