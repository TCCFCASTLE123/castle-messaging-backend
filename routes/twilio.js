const express = require("express");
const twilio = require("twilio");
const db = require("../db");

const router = express.Router();

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const twilioFrom = process.env.TWILIO_PHONE_NUMBER;

function canonicalPhone(input) {
  if (!input) return "";
  const digits = String(input).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10) return digits;
  return digits;
}

function toE164FromCanonical(canon10) {
  const digits = canonicalPhone(canon10);
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.startsWith("+")) return digits;
  return digits.startsWith("+") ? digits : `+${digits}`;
}

function ensureClientByPhone(phoneRaw, defaultName, cb) {
  const phone = canonicalPhone(phoneRaw);
  if (!phone || phone.length < 10) {
    return cb(new Error("Invalid phone: " + phoneRaw));
  }

  db.get("SELECT id FROM clients WHERE phone = ?", [phone], (err, row) => {
    if (err) return cb(err);
    if (row && row.id) return cb(null, row.id, phone);

    db.run(
      `INSERT INTO clients (name, phone, created_at) VALUES (?, ?, datetime('now'))`,
      [defaultName || "(New Lead)", phone],
      function (insertErr) {
        if (!insertErr) return cb(null, this.lastID, phone);

        // If insert failed (likely UNIQUE), lookup again
        db.get("SELECT id FROM clients WHERE phone = ?", [phone], (err2, row2) => {
          if (err2) return cb(err2);
          if (row2 && row2.id) return cb(null, row2.id, phone);
          return cb(insertErr);
        });
      }
    );
  });
}

/**
 * OUTBOUND SMS
 * Apps Script → Node → Twilio
 * POST /api/twilio/send
 * Body: { phone, text, sender? }
 * Header: x-api-key
 */
router.post("/send", (req, res) => {
  const apiKey = req.header("x-api-key");
  if (apiKey !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const phoneRaw = req.body.phone;
  const text = (req.body.text || "").trim();

  // ✅ allow UI to send sender="me" so it doesn't show as automated
  const sender = (req.body.sender || "me").trim();

  const phoneCanon = canonicalPhone(phoneRaw);
  const phoneE164 = toE164FromCanonical(phoneCanon);

  if (!phoneCanon || phoneCanon.length < 10 || !text) {
    return res.status(400).json({ ok: false, error: "Invalid phone or text" });
  }

  ensureClientByPhone(phoneCanon, "(Appointment Lead)", (err, clientId) => {
    if (err) {
      console.error("❌ ensureClientByPhone failed:", err.message);
      return res.status(500).json({ ok: false, error: "Client lookup/create failed" });
    }

    twilioClient.messages
      .create({ from: twilioFrom, to: phoneE164, body: text })
      .then((message) => {
        const ts = new Date().toISOString();

        db.run(
          `
          INSERT INTO messages (client_id, sender, text, direction, timestamp, external_id)
          VALUES (?, ?, ?, ?, ?, ?)
          `,
          [clientId, sender, text, "outbound", ts, message.sid || null],
          function (msgErr) {
            if (msgErr) {
              console.error("❌ Outbound message save failed:", msgErr.message);
              return res.status(500).json({ ok: false, error: "Message save failed" });
            }

            if (req.io) {
              req.io.emit("message", {
                id: this.lastID,
                client_id: clientId,
                phone: phoneCanon,
                sender,
                text,
                direction: "outbound",
                timestamp: ts,
                twilio_sid: message.sid || null,
              });
            }

            res.json({ ok: true, client_id: clientId, phone: phoneCanon, sid: message.sid || null });
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
  // ✅ log FIRST so we can see hits even if Twilio retries
  console.log("📩 INBOUND HIT:", {
    From: req.body.From,
    Body: req.body.Body,
    MessageSid: req.body.MessageSid,
  });

  // ✅ immediately respond so Twilio is happy
  res.type("text/xml").status(200).send("<Response></Response>");

  try {
    const fromRaw = req.body.From;
    const text = (req.body.Body || "").trim();
    const sid = req.body.MessageSid || null;

    const phoneCanon = canonicalPhone(fromRaw);
    if (!phoneCanon || phoneCanon.length < 10 || !text) return;

    ensureClientByPhone(phoneCanon, "(New Reply)", (err, clientId) => {
      if (err) return console.error("❌ inbound ensureClientByPhone failed:", err.message);

      const ts = new Date().toISOString();

      db.run(
        `
        INSERT INTO messages (client_id, sender, text, direction, timestamp, external_id)
        VALUES (?, ?, ?, ?, ?, ?)
        `,
        [clientId, "client", text, "inbound", ts, sid],
        function (msgErr) {
          if (msgErr) return console.error("❌ Inbound message insert failed:", msgErr.message);

          console.log("✅ inbound saved to DB:", { clientId, phoneCanon, text });

          if (req.io) {
            req.io.emit("message", {
              id: this.lastID,
              client_id: clientId,
              phone: phoneCanon,
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

