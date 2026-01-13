const sqlite3 = require("sqlite3").verbose();

const DB_PATH = process.env.SQLITE_PATH || "/var/data/database.sqlite";

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error("❌ SQLite connection failed:", err.message);
  else console.log("✅ SQLite connected:", DB_PATH);
});

db.serialize(() => {
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
  statuses.forEach((s) => db.run(`INSERT OR IGNORE INTO statuses (name) VALUES (?)`, [s]));

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

  db.all("PRAGMA table_info(clients)", (_, rows) => {
    console.log("📦 clients columns:", rows.map((r) => r.name).join(", "));
  });
});

module.exports = db;
