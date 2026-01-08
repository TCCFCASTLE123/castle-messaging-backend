const express = require('express');
const twilio = require('twilio');
const normalizePhone = require('../utils/normalizePhone');
const db = require('../db');

const router = express.Router();

// Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const twilioFrom = process.env.TWILIO_PHONE_NUMBER;

/**
 * =====================================================
 * OUTBOUND SMS
 * Apps Script → Node → Twilio
 * POST /api/twilio/send
 * Body: { phone, text }
 * Header: x-api-key
 * =====================================================
 */
router.post('/send', (req, res) => {
  const apiKey = req.header('x-api-key');
  if (apiKey !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const phoneRaw = req.body.phone;
  const text = (req.body.text || '').trim();
  const phone = normalizePhone(phoneRaw);

  if (!phone || !text) {
    return res.status(400).json({ ok: false, error: 'Invalid phone or text' });
  }

  // Find or create client
  db.get("SELECT id FROM clients WHERE phone = ?", [phone], (err, row) => {
    if (err) return res.status(500).json({ ok: false, error: 'DB lookup failed' });

    const ensureClient = (cb) => {
      if (row && row.id) return cb(row.id);

      db.run(
        "INSERT INTO clients (name, phone) VALUES (?, ?)",
        ['(Appointment Lead)', phone],
        function (insertErr) {
          if (insertErr) return res.status(500).json({ ok: false, error: 'Client create failed' });

          req.io.emit('client_created', {
            id: this.lastID,
            name: '(Appointment Lead)',
            phone,
          });

          cb(this.lastID);
        }
      );
    };

    ensureClient((clientId) => {
      twilioClient.messages
        .create({
          from: twilioFrom,
          to: phone,
          body: text,
        })
        .then((message) => {
          const ts = new Date().toISOString();

          // Save outbound message
          db.run(
            "INSERT INTO messages (client_id, sender, text, direction, timestamp) VALUES (?, ?, ?, ?, ?)",
            [clientId, 'system', text, 'outbound', ts],
            function (msgErr) {
              if (msgErr) return res.status(500).json({ ok: false, error: 'Message save failed' });

              // Emit to React
              req.io.emit('message', {
                client_id: clientId,
                sender: 'system',
                text,
                direction: 'outbound',
                timestamp: ts,
                twilio_sid: message.sid,
              });

              res.json({ ok: true, client_id: clientId });
            }
          );
        })
        .catch((twErr) => {
          console.error('❌ Twilio send failed:', twErr);
          res.status(500).json({ ok: false, error: 'Twilio error' });
        });
    });
  });
});

/**
 * =====================================================
 * INBOUND SMS
 * Twilio → Node → DB → React
 * POST /api/twilio/inbound
 * =====================================================
 */
router.post('/inbound', (req, res) => {
  // Respond immediately so Twilio doesn't retry
  res.status(200).send('<Response></Response>');

  try {
    const fromRaw = req.body.From;
    const body = (req.body.Body || '').trim();
    const from = normalizePhone(fromRaw);

    if (!from || !body) return;

    db.get("SELECT id FROM clients WHERE phone = ?", [from], (err, row) => {
      if (err) return console.error("Inbound lookup failed:", err);

      const ensureClient = (cb) => {
        if (row && row.id) return cb(row.id);

        db.run(
          "INSERT INTO clients (name, phone) VALUES (?, ?)",
          ['(New Reply)', from],
          function (insertErr) {
            if (insertErr) return console.error("Inbound client create failed:", insertErr);

            req.io.emit('client_created', {
              id: this.lastID,
              name: '(New Reply)',
              phone: from,
            });

            cb(this.lastID);
          }
        );
      };

      ensureClient((clientId) => {
        const ts = new Date().toISOString();

        db.run(
          "INSERT INTO messages (client_id, sender, text, direction, timestamp) VALUES (?, ?, ?, ?, ?)",
          [clientId, 'client', body, 'inbound', ts],
          function (msgErr) {
            if (msgErr) return console.error("Inbound message insert failed:", msgErr);

            req.io.emit('message', {
              client_id: clientId,
              sender: 'client',
              text: body,
              direction: 'inbound',
              timestamp: ts,
            });
          }
        );
      });
    });
  } catch (e) {
    console.error("Inbound webhook crashed:", e);
  }
});

module.exports = router;
