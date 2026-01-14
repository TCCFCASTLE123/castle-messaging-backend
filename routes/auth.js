const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../db.js");

const router = express.Router();

function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ message: "Missing token" });

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, username, role }
    next();
  } catch (e) {
    return res.status(401).json({ message: "Invalid/expired token" });
  }
}

// LOGIN
router.post("/login", (req, res) => {
  const username = (req.body.username || "").trim().toLowerCase();
  const password = req.body.password || "";

  if (!username || !password) {
    return res.status(400).json({ message: "Username and password required." });
  }

  db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
    if (err) return res.status(500).json({ message: "DB error." });
    if (!user) return res.status(400).json({ message: "Invalid credentials." });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(400).json({ message: "Invalid credentials." });

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role || "user" },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );

    return res.json({ token, username: user.username, role: user.role || "user" });
  });
});

// ME (verify token)
router.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
