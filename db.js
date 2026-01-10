// db.js
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Make sure this matches the path where you want your SQLite DB file to be!
const db = new sqlite3.Database(path.resolve(__dirname, 'database.sqlite'));
// ---- One-time DB migration(s) ----
db.run("ALTER TABLE clients ADD COLUMN language TEXT", (err) => {
  if (err) {
    // Ignore if the column already exists
    if (!String(err.message).includes("duplicate column name")) {
      console.error("DB migration failed (clients.language):", err.message);
    }
  } else {
    console.log("DB migration applied: clients.language column added");
  }
});


// Clients table
db.run(`
  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    notes TEXT
  )
`);

// Messages table
db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    sender TEXT NOT NULL,
    text TEXT NOT NULL,
    direction TEXT,           -- <-- ADD THIS LINE
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    external_id TEXT,         -- <-- AND THIS LINE
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

module.exports = db;

