require("dotenv").config();
const bcrypt = require("bcryptjs");
const db = require("../db.js");

const [, , rawUsername, rawPassword, rawRole] = process.argv;

const username = (rawUsername || "").trim().toLowerCase();
const password = rawPassword || "";
const role = (rawRole || "user").trim().toLowerCase();

if (!username || !password) {
  console.log("Usage: node scripts/createUser.js <username> <password> [role]");
  console.log("Example: node scripts/createUser.js cass MyPass123 admin");
  process.exit(1);
}

if (!["admin", "user"].includes(role)) {
  console.log("Role must be admin or user");
  process.exit(1);
}

db.get("SELECT id FROM users WHERE username = ?", [username], async (err, row) => {
  if (err) {
    console.error("DB error:", err);
    process.exit(1);
  }

  if (row) {
    console.log("❌ User already exists:", username);
    process.exit(1);
  }

  const password_hash = await bcrypt.hash(password, 10);

  db.run(
    "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    [username, password_hash, role],
    function (err2) {
      if (err2) {
        console.error("Insert error:", err2);
        process.exit(1);
      }
      console.log("✅ Created user:", username, "role:", role);
      process.exit(0);
    }
  );
});
