const bcrypt = require("bcryptjs");
const db = require("../db");

const [, , newPasswordRaw] = process.argv;

if (!newPasswordRaw) {
  console.error("❌ Usage: node scripts/resetAllPasswords.js <newPassword>");
  process.exit(1);
}

const newPassword = String(newPasswordRaw); // ✅ do not trim

(async () => {
  const hash = await bcrypt.hash(newPassword, 10);

  db.run(
    "UPDATE users SET password_hash = ?",
    [hash],
    function (err) {
      if (err) {
        console.error("❌ Failed to reset passwords:", err.message);
        process.exit(1);
      }
      console.log(`✅ Reset password for ${this.changes} users`);
      process.exit(0);
    }
  );
})();
