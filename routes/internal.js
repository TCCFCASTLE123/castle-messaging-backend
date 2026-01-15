// routes/internal.js
const express = require("express");
const router = express.Router();
const db = require("../db");

const twilio = require("twilio");

// Use a Twilio client instance
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

/**
 * Machine auth: x-api-key
 * This is what Apps Script uses.
 */
function requireInternalKey(req, res, next) {
  const key = req.headers["x-api-key"];

  if (!process.env.INTERNAL_API_KEY) {
    return res.status(500).json({ message: "INTERNAL_API_KEY not set" });
  }

  if (!key || key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ message: "Invalid internal key" });
  }

  next();
}

/**
 * Normalize phone for DB lookup (digits only, 10-digit US)
 */
function canonicalPhoneDigits(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10) return digits;
  return digits;
}

/**
 * POST /api/internal/send-sms
 * Headers: x-api-key: <INTERNAL_API_KEY>
 * Body: { phone, text, sender? }
 *
 * - Sends Twilio SMS
 * - Saves message to DB
 * - Emits socket event so React updates
 */
router.post("/send-sms", requireInternalKey, (req, res) => {
  try {
    const to = String(req.body.phone || "").trim();
    const text = String(req.body.text || "").trim();
    const sender = String(req.body.sender || "system").trim(); // "system" is fine for automation

    if (!to || !text) {
      return res.status(400).json({ message: "phone and text required" });
    }

    if (!process.env.TWILIO_PHONE_NUMBER) {
      return res.status(500).json({ message: "TWILIO_PHONE_NUMBER not set" });
    }

    // 1) Send SMS via Twilio
    twilioClient.messages
      .create({
        to,
        from: process.env.TWILIO_PHONE_NUMBER,
        body: text,
      })
      .then((tw) => {
        const timestamp = new Date().toISOString();

        // 2) Find client_id by phone (optional but ideal)
        const digits = canonicalPhoneDigits(to);

        db.get("SELECT id, name FROM clients WHERE phone = ?", [digits], (err, clientRow) => {
          if (err) {
            console.error("❌ internal send-sms client lookup error:", err);
            // Still return success for SMS, but DB may not have client_id
          }

          const clientId = clientRow?.id || null;
          const clientName = clientRow?.name || null;

          // 3) Save to DB
          // NOTE: This assumes your messages table has these columns:
          // (client_id, sender, text, direction, timestamp, external_id, phone)
          db.run(
            `INSERT INTO messages (client_id, sender, text, direction, timestamp, external_id, phone)
             VALUES (?, ?, ?, 'outbound', ?, ?, ?)`,
            [clientId, sender, text, timestamp, tw.sid, to],
            (err2) => {
              if (err2) {
                console.error("❌ internal send-sms DB insert error:", err2);
                // We still return success because the SMS sent; but log for debugging.
              }

              // 4) Emit to UI
              if (req.io) {
                req.io.emit("newMessage", {
                  client_id: clientId,
                  client_name: clientName,
                  sender, // will show as "system" in your UI
                  text,
                  direction: "outbound",
                  timestamp,
                  external_id: tw.sid,
                  phone: to,
                });
              }

              return res.json({ success: true, sid: tw.sid });
            }
          );
        });
      })
      .catch((e) => {
        console.error("❌ internal send-sms Twilio error:", e);
        return res.status(500).json({ message: "Twilio send failed", error: String(e?.message || e) });
      });
  } catch (e) {
    console.error("❌ internal send-sms error:", e);
    return res.status(500).json({ message: "Internal send failed", error: String(e?.message || e) });
  }
});

module.exports = router;
