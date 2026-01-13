// db.js
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

// DB file
const db = new sqlite3.Database(path.resolve(__dirname, "database.sqlite"));

// Make startup statements run in order
db.serialize(() => {
  // 1) Create clients table WITH language included (for fresh DBs)
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

  // 2) Migrate older DBs that already had clients but no language
  db.run("ALTER TABLE clients ADD COLUMN language TEXT", (err) => {
    if (err) {
      // Ignore if it already exists
      const msg = String(err.message || "");
      if (
        !msg.includes("duplicate column name") &&
        !msg.includes("no such table")
      ) {
        console.error("DB migration failed (clients.language):", err.message);
      }
    } else {
      console.log("DB migration applied: clients.language column added");
    }
  });

  // Messages table
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      sender TEXT NOT NULL,
      text TEXT NOT NULL,
      direction TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      external_id TEXT,
      FOREIGN KEY (client_id) REFERENCES clients(id)
    )
  `);

  // Users table
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'admin'
    )
  `);

  // Optional: log columns so you can SEE it worked in Render logs
  db.all("PRAGMA table_info(clients)", (e, rows) => {
    if (!e && rows) {
      console.log("clients columns:", rows.map(r => r.name).join(", "));
    }
  });
});

module.exports = db;
