const express = require("express");
const twilio = require("twilio");
const normalizePhone = require("../utils/normalizePhone");
const db = require("../db");

const router = express.Router();

// Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const twilioFrom = process.env.TWILIO_PHONE_NUMBER;

/**
 * Helper: find or create client by phone (phone is unique)
 */
function ensureClientByPhone(phone, defaultName, cb) {
  db.get("SELECT id, name FROM clients WHERE phone = ?", [phone], (err, row) => {
    if (err) return cb(err);

    if (row && row.id) return cb(null, row.id);

    db.run(
      "INSERT INTO clients (name, phone, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))",
      [defaultName || "(New Lead)", phone],
      function (insertErr) {
        if (insertErr) return cb(insertErr);

        cb(null, this.lastID);
      }
    );
  });
}

/**
 * OUTBOUND SMS
 * Apps Script → Node → Twilio
 * POST /api/twilio/send
 * Body: { phone, text }
 * Header: x-api-key
 */
router.post("/send", (req, res) => {
  const apiKey = req.header("x-api-key");
  if (apiKey !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const phoneRaw = req.body.phone;
  const text = (req.body.text || "").trim();
  const phone = normalizePhone(phoneRaw);

  if (!phone || !text) {
    return res.status(400).json({ ok: false, error: "Invalid phone or text" });
  }

  ensureClientByPhone(phone, "(Appointment Lead)", (err, clientId) => {
    if (err) {
      console.error("❌ ensureClientByPhone failed:", err.message);
      return res.status(500).json({ ok: false, error: "Client lookup/create failed" });
    }

    // Send via Twilio
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
          "INSERT INTO messages (client_id, sender, text, direction, timestamp, external_id, phone) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [clientId, "system", text, "outbound", ts, message.sid || null, phone],
          function (msgErr) {
            if (msgErr) {
              console.error("❌ Outbound message save failed:", msgErr.message);
              return res.status(500).json({ ok: false, error: "Message save failed" });
            }

            // Emit to React realtime
            if (req.io) {
              req.io.emit("message", {
                id: this.lastID,
                client_id: clientId,
                phone,
                sender: "system",
                text,
                direction: "outbound",
                timestamp: ts,
                twilio_sid: message.sid || null,
              });
            }

            res.json({ ok: true, client_id: clientId, phone, sid: message.sid || null });
          }
        );
      })
      .catch((twErr) => {
        console.error("❌ Twilio send failed:", twErr);
        res.status(500).json({ ok: false, error: "Twilio error" });
      });
  });
});

/**
 * INBOUND SMS
 * Twilio → Node → DB → React
 * POST /api/twilio/inbound
 */
router.post("/inbound", (req, res) => {
  // ✅ Respond immediately with TwiML (prevents retries)
  res.type("text/xml").status(200).send("<Response></Response>");

  try {
    const fromRaw = req.body.From;
    const text = (req.body.Body || "").trim();
    const sid = req.body.MessageSid || null;

    const phone = normalizePhone(fromRaw);

    if (!phone || !text) return;

    ensureClientByPhone(phone, "(New Reply)", (err, clientId) => {
      if (err) return console.error("❌ inbound ensureClientByPhone failed:", err.message);

      const ts = new Date().toISOString();

      db.run(
        "INSERT INTO messages (client_id, sender, text, direction, timestamp, external_id, phone) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [clientId, "client", text, "inbound", ts, sid, phone],
        function (msgErr) {
          if (msgErr) return console.error("❌ Inbound message insert failed:", msgErr.message);

          if (req.io) {
            req.io.emit("message", {
              id: this.lastID,
              client_id: clientId,
              phone,
              sender: "client",
              text,
              direction: "inbound",
              timestamp: ts,
              twilio_sid: sid,
            });
          }
        }
      );
    });
  } catch (e) {
    console.error("❌ Inbound webhook crashed:", e);
  }
});

module.exports = router;
