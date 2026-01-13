// db.js — CLEAN + SELF-MIGRATING (stops the “missing column” whack-a-mole)
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const DB_PATH = path.join(__dirname, "database.sqlite");

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error("❌ SQLite connection failed:", err.message);
  else console.log("✅ SQLite connected:", DB_PATH);
});

function tableColumns(table) {
  return new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(${table})`, (err, rows) => {
      if (err) return reject(err);
      resolve(rows.map((r) => r.name));
    });
  });
}

async function addColumnIfMissing(table, colName, colDefSql) {
  const cols = await tableColumns(table);
  if (cols.includes(colName)) return;

  await new Promise((resolve, reject) => {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${colName} ${colDefSql}`, (err) => {
      if (err) return reject(err);
      console.log(`➕ Added column ${table}.${colName}`);
      resolve();
    });
  });
}

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
     MESSAGES
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
     STATUSES (lookup; optional)
  ========================= */
  db.run(`
    CREATE TABLE IF NOT EXISTS statuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    )
  `);

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
     SEED LOOKUPS
  ========================= */
  // These can be whatever you want; the important part is clients.status exists.
  const seedStatuses = [
    "Set",
    "No show",
    "Working to set",
    "Attempted/unsuccessful",
    "Did not retain",
    "Pending",
    "Retained",
  ];
  seedStatuses.forEach((s) => db.run(`INSERT OR IGNORE INTO statuses (name) VALUES (?)`, [s]));
});

// Run migrations after base tables exist
(async () => {
  try {
    // ---- Clients: add the fields your UI/workflow needs
    await addColumnIfMissing("clients", "office", "TEXT");                 // PHX | MESA | OP
    await addColumnIfMissing("clients", "status", "TEXT");                 // Set | No show | ...
    await addColumnIfMissing("clients", "case_type", "TEXT");              // Immigration | ...
    await addColumnIfMissing("clients", "appointment_at", "TEXT");         // ISO string recommended
    await addColumnIfMissing("clients", "created_at", "TEXT DEFAULT (datetime('now'))");
    await addColumnIfMissing("clients", "updated_at", "TEXT");

    // ---- Messages: add commonly expected fields without breaking legacy code
    await addColumnIfMissing("messages", "phone", "TEXT");                 // convenience
    await addColumnIfMissing("messages", "body", "TEXT");                  // if routes use body instead of text
    await addColumnIfMissing("messages", "twilio_sid", "TEXT");            // if routes use twilio_sid
    await addColumnIfMissing("messages", "delivery_status", "TEXT");       // sent/delivered/failed
    await addColumnIfMissing("messages", "created_at", "TEXT DEFAULT (datetime('now'))");

    // Helpful: show final schemas at boot
    const clientsCols = await tableColumns("clients");
    const messagesCols = await tableColumns("messages");
    console.log("📦 clients columns:", clientsCols.join(", "));
    console.log("📦 messages columns:", messagesCols.join(", "));
  } catch (e) {
    console.error("❌ Migration error:", e.message);
  }
})();

module.exports = db;
