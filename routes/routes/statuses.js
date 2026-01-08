const express = require('express');
const router = express.Router();
const db = require('../db.js');

// GET all statuses
router.get('/', (req, res) => {
  console.log("Statuses route hit!");
  db.all('SELECT * FROM statuses', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

module.exports = router;


