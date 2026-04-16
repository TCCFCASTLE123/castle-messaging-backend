// routes/internal.js
const express = require("express");
const router = express.Router();
const db = require("../db");

const twilio = require("twilio");
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/* ------------------------------------------------------------------ */
/* AUTH */
/* ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------ */
/* PHONE NORMALIZATION */
/* DB format: 10 digits */
/* Twilio format: +1XXXXXXXXXX */
/* ------------------------------------------------------------------ */
function normalizeForDb(input) {
  if (!input) return "";
  const digits = String(input).replace(/\D/g, "");

  if (digits.length === 11 && digits.startsWith("1")) {
    return digits.slice(1);
  }
  if (digits.length === 10) {
    return digits;
  }
  return "";
}

function normalizeForTwilio(input) {
  const dbPhone = normalizeForDb(input);
  if (!dbPhone) return "";
  return `+1${dbPhone}`;
}

/* ------------------------------------------------------------------ */
/* DB HELPERS */
/* ------------------------------------------------------------------ */
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) =>
      err ? reject(err) : resolve(row)
    );
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

/* ------------------------------------------------------------------ */
/* CLIENT LOOKUP */
/* ------------------------------------------------------------------ */
async function findClientByPhone(rawPhone) {
  const phone = normalizeForDb(rawPhone);
  if (!phone) return null;

  return await dbGet(
    `
    SELECT id, name
    FROM clients
    WHERE
      REPLACE(REPLACE(REPLACE(REPLACE(phone,'-',''),'(',''),')',''),' ','') = ?
    `,
    [phone]
  );
}

/* ------------------------------------------------------------------ */
/* TWILIO HELPERS */
/* ------------------------------------------------------------------ */
async function sendClientSms({ to, body }) {
  if (!process.env.TWILIO_PHONE_NUMBER) {
    throw new Error("TWILIO_PHONE_NUMBER not set");
  }

  const e164 = normalizeForTwilio(to);
  if (!e164) {
    throw new Error("Invalid client phone number");
  }

  return await twilioClient.messages.create({
    to: e164,
    from: process.env.TWILIO_PHONE_NUMBER,
    body,
  });
}

/* ------------------------------------------------------------------ */
/* ROUTES */
/* ------------------------------------------------------------------ */

/**
 * Sends SMS to a CLIENT and stores it in messages table
 * 🚫 DOES NOT auto-create clients
 */
router.post("/send-sms", requireInternalKey, async (req, res) => {
  try {
    const rawPhone = String(req.body.phone || "").trim();
    const text = String(req.body.text || "").trim();
    const sender = String(req.body.sender || "system").trim();
    const timestamp = new Date().toISOString();

    if (!rawPhone || !text) {
      return res.status(400).json({ message: "phone and text required" });
    }

    const client = await findClientByPhone(rawPhone);

    if (!client?.id) {
      return res.status(400).json({
        message: "Client not found in CRM. Sheet must sync first.",
        raw: rawPhone,
        normalized: normalizeForDb(rawPhone),
      });
    }

    // 1️⃣ Send via Twilio
    const tw = await sendClientSms({ to: rawPhone, body: text });

    // 2️⃣ Save message
    await dbRun(
      `INSERT INTO messages
       (client_id, sender, text, direction, timestamp, external_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [client.id, sender, text, "outbound", timestamp, tw.sid]
    );

    // 3️⃣ Emit to UI
if (req.io) {
  req.io.emit("newMessage", {
    client_id: client.id,
    user: sender,              // ✅ matches frontend
    body: text,                // ✅ matches frontend
    direction: "outbound",
    created_at: timestamp,     // ✅ matches frontend
    external_id: tw.sid,
  });
}
return res.json({
  success: true,
  sid: tw.sid,
  client_id: client.id,

  // ✅ Match CRM expectations
  user: sender,
  body: text,
  created_at: timestamp,
  direction: "outbound",
});
  } catch (err) {
    console.error("❌ /api/internal/send-sms error:", err);
    return res.status(500).json({
      message: "Internal send failed",
      error: String(err?.message || err),
    });
  }
});

module.exports = router;
