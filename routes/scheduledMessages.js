// In routes/scheduledMessages.js

const express = require('express');
const router = express.Router();
const db = require('../db');

// Get all scheduled messages (optionally for a client)
router.get('/', (req, res) => {
  const clientId = req.query.client_id;
  if (clientId) {
    db.all('SELECT * FROM scheduled_messages WHERE client_id = ? ORDER BY send_time DESC', [clientId], (err, rows) => {
      if (err) return res.status(500).json({ error: 'DB error' });
      res.json(rows);
    });
  } else {
    db.all('SELECT * FROM scheduled_messages ORDER BY send_time DESC', [], (err, rows) => {
      if (err) return res.status(500).json({ error: 'DB error' });
      res.json(rows);
    });
  }
});

// (You can add POST/PUT/DELETE endpoints here if needed)

module.exports = router;
