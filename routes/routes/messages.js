// routes/messages.js

const express = require('express');
const router = express.Router();
const db = require('../db');
const twilio = require('twilio');
require('dotenv').config();

const accountSid = process.env.TWILIO_ACCOUNT_SID 
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioNumber = process.env.TWILIO_PHONE_NUMBER;
const client = twilio(accountSid, authToken);
const normalizePhone = require('../utils/normalizePhone');

// --- Helper: Log message to DB (for use everywhere) ---
function logMessageToDB(client_id, sender, text, direction = 'outbound', callback) {
  const timestamp = new Date().toISOString();
  db.run(
    "INSERT INTO messages (client_id, sender, text, timestamp, direction) VALUES (?, ?, ?, ?, ?)",
    [client_id, sender, text, timestamp, direction],
    function (err) {
      if (err) {
        console.error("Failed to log message:", err);
        if (callback) callback(err);
      } else {
        if (callback) callback(null, this.lastID);
      }
    }
  );
}

// === OUTBOUND: Send SMS via Twilio and save to DB ===
router.post('/send', (req, res) => {
  const { to, text, client_id } = req.body;
  if (!to || !text || !client_id) {
    return res.status(400).json({ error: "Missing 'to', 'text', or 'client_id'" });
  }

  client.messages.create({
    body: text,
    from: twilioNumber,
    to: to
  })
    .then(message => {
      logMessageToDB(client_id, 'me', text, 'outbound', (err, id) => {
        if (err) {
          return res.status(500).json({ error: "SMS sent, but not saved in DB." });
        }
        res.json({ success: true, sid: message.sid });
      });
    })
    .catch(err => {
      console.error("Twilio send error:", err);
      res.status(500).json({ error: err.message });
    });
});

// === INBOUND: Twilio webhook, auto-create client if needed ===
router.post('/inbound', express.urlencoded({ extended: false }), (req, res) => {
  const { From, Body } = req.body;
  if (!From || !Body) {
    console.log('Malformed inbound:', req.body);
    return res.status(400).end();
  }

  db.get("SELECT id FROM clients WHERE phone = ?", [From], (err, clientRow) => {
    if (err) {
      console.error("DB error:", err);
      return res.status(500).end();
    }

    const logInbound = (clientId) => {
      logMessageToDB(clientId, "client", Body, 'inbound', () => res.status(200).end());
    };

    if (!clientRow) {
      db.run(
        "INSERT INTO clients (name, phone, language, notes) VALUES (?, ?, ?, ?)",
        ["Unknown", From, "en", "Auto-created from inbound SMS"],
        function (err) {
          if (err) {
            console.error("Failed to create client from inbound SMS:", err);
            return res.status(500).end();
          }
          logInbound(this.lastID);
        }
      );
    } else {
      logInbound(clientRow.id);
    }
  });
});

// === FETCH conversation history ===
router.get('/conversation/:client_id', (req, res) => {
  const clientId = req.params.client_id;
  db.all(
    "SELECT * FROM messages WHERE client_id = ? ORDER BY timestamp ASC",
    [clientId],
    (err, rows) => {
      if (err) {
        console.error('DB error:', err);
        return res.status(500).json([]);
      }
      res.json(rows || []);
    }
  );
});

// === POST message from web app (save to DB only, no SMS) ===
router.post('/:clientId', (req, res) => {
  const { clientId } = req.params;
  const { sender, text } = req.body;
  if (!text || !sender) return res.status(400).json({ error: "Missing fields" });

  logMessageToDB(clientId, sender, text, 'outbound', (err, id) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({
      id,
      client_id: clientId,
      sender,
      text,
      timestamp: new Date().toISOString(),
      direction: 'outbound',
    });
  });
});

// --- Export the logging function for use in other routes (like statuses, automation) ---
module.exports = router;
module.exports.logMessageToDB = logMessageToDB;
