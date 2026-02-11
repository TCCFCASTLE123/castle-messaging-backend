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
/* PHONE NORMALIZATION (SINGLE SOURCE OF TRUTH) */
/* DB format: 10 digits
/* Twilio format: +1XXXXXXXXXX
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
/* FRONTEND LINK */
/* ------------------------------------------------------------------ */
function buildFrontendInboxLink() {
  const baseUrl = String(process.env.FRONTEND_URL || "")
    .trim()
    .replace(/\/+$/, "");
  return baseUrl ? `${baseUrl}/inbox` : "";
}

/* ------------------------------------------------------------------ */
/* TWILIO HELPERS */
/* ------------------------------------------------------------------ */
async function sendInternalSms({ to, body }) {
  const msg = {
    to: normalizeForTwilio(to),
    body,
  };

  if (!msg.to) {
    throw new Error("Invalid internal phone number");
  }

  if (process.env.TWILIO_INTERNAL_MESSAGING_SERVICE_SID) {
    msg.messagingServiceSid =
      process.env.TWILIO_INTERNAL_MESSAGING_SERVICE_SID;
  } else if (process.env.TWILIO_INTERNAL_FROM) {
    msg.from = process.env.TWILIO_INTERNAL_FROM;
  } else {
    throw new Error(
      "Missing TWILIO_INTERNAL_MESSAGING_SERVICE_SID and TWILIO_INTERNAL_FROM"
    );
  }

  return await twilioClient.messages.create(msg);
}

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

let client = await findClientByPhone(rawPhone);

if (!client?.id) {
  const phone = normalizeForDb(rawPhone);

  if (!phone) {
    return res.status(400).json({
      message: "Invalid phone number",
      raw: rawPhone,
    });
  }

  const name = "CALL Appointment";

  await dbRun(
    "INSERT INTO clients (name, phone) VALUES (?, ?)",
    [name, phone]
  );

  client = await findClientByPhone(rawPhone);
}


    // 1) Send via Twilio
    const tw = await sendClientSms({ to: rawPhone, body: text });

    // 2) Save message
    await dbRun(
      `INSERT INTO messages
       (client_id, sender, text, direction, timestamp, external_id)
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
    return res.status(500).json({
      message: "Internal send failed",
      error: String(err?.message || err),
    });
  }
});

/**
 * Sends SMS to a TEAM MEMBER (internal notification)
 */
router.post("/notify-team", requireInternalKey, async (req, res) => {
  try {
    const to = String(req.body.phone || "").trim();
    if (!to) return res.status(400).json({ message: "phone required" });

    const clientName = String(req.body.clientName || "Client").trim();
    const preview = String(req.body.preview || "New message").trim();

    const link = buildFrontendInboxLink();

    const lines = [];
    lines.push(`New inbound SMS from ${clientName}:`);
    lines.push("");
    lines.push(`"${preview.slice(0, 160)}"`);

    if (link) {
      lines.push("");
      lines.push("Open conversation:");
      lines.push(link);
    }

    const body = lines.join("\n");

    const tw = await sendInternalSms({ to, body });

    return res.json({ success: true, sid: tw.sid });
  } catch (err) {
    console.error("❌ /api/internal/notify-team error:", err);
    return res.status(500).json({
      message: "Notify failed",
      error: String(err?.message || err),
    });
  }
});

module.exports = router;
