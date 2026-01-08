const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db.js');
const router = express.Router();

// Register a new user
router.post('/register', async (req, res) => {
  const { username, password } = req.body;
  db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
    if (user) return res.status(400).json({ message: 'User already exists.' });
    const hashedPassword = await bcrypt.hash(password, 10);
    db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashedPassword], function(err) {
      if (err) return res.status(500).json({ message: 'Error registering user.' });
      res.status(201).json({ id: this.lastID, username });
    });
  });
});

// Login user
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
    if (!user) return res.status(400).json({ message: 'Invalid credentials.' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ message: 'Invalid credentials.' });
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, process.env.JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, username: user.username, role: user.role });
  });
});

module.exports = router;
