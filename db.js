// db.js — CLEAN + SELF-MIGRATING (with UNIQUE phone index)
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

function tableColumns(table) {
  return new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(${table})`, (err, rows) => {
      if (err) return reject(err);
      resolve((rows || []).map((r) => r.name));
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

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err) => (err ? reject(err) : resolve()));
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
});

// Run migrations after base tables exist
(async () => {
  try {
    // ---- Clients: add the fields your UI/workflow needs
    await addColumnIfMissing("clients", "office", "TEXT");
    await addColumnIfMissing("clients", "status", "TEXT");
    await addColumnIfMissing("clients", "case_type", "TEXT");
    await addColumnIfMissing("clients", "appointment_at", "TEXT");
    await addColumnIfMissing("clients", "created_at", "TEXT DEFAULT (datetime('now'))");
    await addColumnIfMissing("clients", "updated_at", "TEXT");

    // ---- Messages: add commonly expected fields (optional)
    await addColumnIfMissing("messages", "phone", "TEXT");
    await addColumnIfMissing("messages", "body", "TEXT");
    await addColumnIfMissing("messages", "twilio_sid", "TEXT");
    await addColumnIfMissing("messages", "delivery_status", "TEXT");
    await addColumnIfMissing("messages", "created_at", "TEXT DEFAULT (datetime('now'))");

    // ✅ CRITICAL FIX: ensure phone is UNIQUE for ON CONFLICT(phone)
    // Safe: allows multiple NULL phones, enforces uniqueness on real numbers
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_phone_unique ON clients(phone)`);

    // Helpful: show final schemas at boot
    const clientsCols = await tableColumns("clients");
    const messagesCols = await tableColumns("messages");
    console.log("📦 clients columns:", clientsCols.join(", "));
    console.log("📦 messages columns:", messagesCols.join(", "));
    console.log("✅ Ensured UNIQUE index on clients(phone)");
  } catch (e) {
    console.error("❌ Migration error:", e.message);
  }
})();

module.exports = db;
