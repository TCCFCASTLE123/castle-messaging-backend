const express = require("express");
const router = express.Router();
const twilio = require("twilio");
const db = require("../db");

const MessagingResponse = twilio.twiml.MessagingResponse;

function canonicalPhone(input) {
  if (!input) return "";
  const digits = String(input).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

function toE164FromCanonical(canon10) {
  if (!canon10) return "";
  const digits = String(canon10).replace(/\D/g, "");
  if (digits.length !== 10) return "";
  return `+1${digits}`;
}

router.post("/inbound", async (req, res) => {
  res.type("text/xml");

  try {
    console.log("📩 INBOUND HIT:", {
      From: req.body.From,
      To: req.body.To,
      Body: req.body.Body,
      MessageSid: req.body.MessageSid,
    });

    const fromCanon = canonicalPhone(req.body.From || "");
    const fromE164 = toE164FromCanonical(fromCanon);
    const body = (req.body.Body || "").trim();
    const sid = req.body.MessageSid || null;

    if (!fromCanon || fromCanon.length !== 10 || !body) {
      const twiml = new MessagingResponse();
      return res.status(200).send(twiml.toString());
    }

    const clientRow = await new Promise((resolve, reject) => {
      db.get(
        "SELECT id, phone, name FROM clients WHERE phone = ?",
        [fromCanon],
        (err, row) => (err ? reject(err) : resolve(row || null))
      );
    });

    let client_id = clientRow?.id;
    let client_name = clientRow?.name || null;

    if (!client_id) {
      const createdAt = new Date().toISOString();
      const placeholderName = `Inbound ${fromE164 || fromCanon}`;

      client_id = await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO clients (name, phone, created_at, last_message_at, last_message_text)
           VALUES (?, ?, ?, ?, ?)`,
          [placeholderName, fromCanon, createdAt, createdAt, body],
          function (err) {
            if (err) return reject(err);
            resolve(this.lastID);
          }
        );
      });

      client_name = placeholderName;
    }

    const ts = new Date().toISOString();

    const messageId = await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO messages (client_id, sender, text, direction, timestamp, external_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [client_id, "client", body, "inbound", ts, sid],
        function (err) {
          if (err) return reject(err);
          resolve(this.lastID);
        }
      );
    });

    // ✅ Persist “phone-like ordering”
    db.run(
      `UPDATE clients SET last_message_at = ?, last_message_text = ? WHERE id = ?`,
      [ts, body, client_id]
    );

    const payload = {
      id: messageId,
      client_id,
      client_name: client_name || undefined,
      phone: fromE164 || fromCanon,
      phone_canonical: fromCanon,
      sender: "client",
      text: body,
      direction: "inbound",
      timestamp: ts,
      external_id: sid,
    };

    if (req.io) {
      req.io.emit("newMessage", payload);
      req.io.emit("message", payload);
    }

    const twiml = new MessagingResponse();
    return res.status(200).send(twiml.toString());
  } catch (err) {
    console.error("❌ Twilio inbound handler failed:", err);
    const twiml = new MessagingResponse();
    return res.status(200).send(twiml.toString());
  }
});

module.exports = router;
