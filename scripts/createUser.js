const bcrypt = require("bcryptjs");
const db = require("../db");

const [, , usernameRaw, passwordRaw, roleRaw = "user"] = process.argv;

if (!usernameRaw || !passwordRaw) {
  console.error("❌ Usage: node scripts/createUser.js <username> <password> [role]");
  process.exit(1);
}

const username = String(usernameRaw).trim().toLowerCase(); // ✅ match login
const password = String(passwordRaw); // ✅ do not trim
const role = String(roleRaw).trim() || "user";

db.get("SELECT id FROM users WHERE username = ?", [username], async (err, row) => {
  if (err) {
    console.error("❌ DB error:", err.message);
    process.exit(1);
  }
  if (row) {
    console.error("❌ User already exists:", username);
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 10);

  db.run(
    "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    [username, hash, role],
    function (err) {
      if (err) {
        console.error("❌ Failed to create user:", err.message);
        process.exit(1);
      }
      console.log(`✅ User created: ${username} (${role})`);
      process.exit(0);
    }
  );
});
