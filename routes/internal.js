// routes/internal.js
const express = require("express");
const router = express.Router();
const db = require("../db");

const twilio = require("twilio");
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

function requireInternalKey(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!process.env.INTERNAL_API_KEY) return res.status(500).json({ message: "INTERNAL_API_KEY not set" });
  if (!key || key !== process.env.INTERNAL_API_KEY) return res.status(401).json({ message: "Invalid internal key" });
  next();
}

function digits10(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  return d;
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

async function findClientByPhone(toRaw) {
  const d = digits10(toRaw);
  const plus1 = "+1" + d;
  const one = "1" + d;

  // your DB stores phones as digits (ex: 4242003548) so this covers all cases
  return await dbGet(
    `SELECT id, name
     FROM clients
     WHERE phone = ?
        OR phone = ?
        OR phone = ?
        OR phone LIKE ?`,
    [d, plus1, one, "%" + d]
  );
}

router.post("/send-sms", requireInternalKey, async (req, res) => {
  try {
    const to = String(req.body.phone || "").trim();
    const text = String(req.body.text || "").trim();
    const sender = String(req.body.sender || "system").trim();
    const timestamp = new Date().toISOString();

    if (!to || !text) return res.status(400).json({ message: "phone and text required" });
    if (!process.env.TWILIO_PHONE_NUMBER) return res.status(500).json({ message: "TWILIO_PHONE_NUMBER not set" });

    const client = await findClientByPhone(to);
    if (!client?.id) {
      return res.status(400).json({ message: "Could not match client by phone", to });
    }

    // 1) Send Twilio
    const tw = await twilioClient.messages.create({
      to,
      from: process.env.TWILIO_PHONE_NUMBER,
      body: text,
    });

    // 2) Save to DB (MATCHES YOUR SCHEMA)
    await dbRun(
      `INSERT INTO messages (client_id, sender, text, direction, timestamp, external_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [client.id, sender, text, "outbound", timestamp, tw.sid]
    );

    // 3) Emit to UI
    if (req.io) {
      req.io.emit("newMessage", {
        client_id: client.id,
        client_name: client.name,
        sender,
        text,
        direction: "outbound",
        timestamp,
        external_id: tw.sid,
      });
    }

    return res.json({ success: true, sid: tw.sid, client_id: client.id });
  } catch (err) {
    console.error("❌ /api/internal/send-sms error:", err);
    return res.status(500).json({ message: "Internal send failed", error: String(err?.message || err) });
  }
});

module.exports = router;
