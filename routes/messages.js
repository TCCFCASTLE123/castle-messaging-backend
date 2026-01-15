// routes/messages.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const twilio = require("twilio");

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
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

function digits10(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  return d;
}

router.get("/conversation/:clientId", async (req, res) => {
  try {
    const clientId = Number(req.params.clientId);
    if (!clientId) return res.status(400).json({ message: "Invalid clientId" });

    const rows = await dbAll(
      `SELECT id, client_id, sender, text, direction, timestamp, external_id, user_id
       FROM messages
       WHERE client_id = ?
       ORDER BY id ASC`,
      [clientId]
    );

    res.json(rows);
  } catch (e) {
    console.error("❌ GET conversation error:", e);
    res.status(500).json({ message: "Failed to load conversation" });
  }
});

// SEND (agent -> client) — saves sender=username + user_id
router.post("/send", async (req, res) => {
  try {
    const toRaw = req.body.to || req.body.phone || "";
    const text = String(req.body.text || "").trim();
    const clientId = Number(req.body.client_id);

    if (!text) return res.status(400).json({ message: "Text required" });
    if (!clientId) return res.status(400).json({ message: "client_id required" });

    const client = await dbGet(`SELECT id, name, phone FROM clients WHERE id = ?`, [clientId]);
    if (!client) return res.status(404).json({ message: "Client not found" });

    const toDigits = digits10(toRaw || client.phone);
    if (!toDigits || toDigits.length < 10) return res.status(400).json({ message: "Invalid phone" });

    const toE164 = "+1" + toDigits;

    if (!process.env.TWILIO_PHONE_NUMBER) {
      return res.status(500).json({ message: "TWILIO_PHONE_NUMBER not set" });
    }

    // ✅ who sent it (from auth)
    const userId = req.user?.id || null;
    const username = (req.user?.username || "agent").trim();

    // 1) Send Twilio
    const tw = await twilioClient.messages.create({
      to: toE164,
      from: process.env.TWILIO_PHONE_NUMBER,
      body: text,
    });

    const timestamp = new Date().toISOString();

    // 2) Save to DB
    await dbRun(
      `INSERT INTO messages (client_id, sender, text, direction, timestamp, external_id, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [client.id, username, text, "outbound", timestamp, tw.sid, userId]
    );

    // 3) Emit to UI
    if (req.io) {
      req.io.emit("newMessage", {
        client_id: client.id,
        client_name: client.name,
        sender: username,
        user_id: userId,
        text,
        direction: "outbound",
        timestamp,
        external_id: tw.sid,
      });
    }

    return res.json({ success: true, sid: tw.sid, client_id: client.id });
  } catch (err) {
    console.error("❌ POST /api/messages/send error:", err);
    return res.status(500).json({ message: "Send failed", error: String(err?.message || err) });
  }
});

module.exports = router;

