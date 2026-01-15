// routes/internal.js
const express = require("express");
const router = express.Router();
const db = require("../db");

const twilio = require("twilio");
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

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

function phoneDigits10(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10) return digits;
  return digits;
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
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

let MESSAGE_COLS_CACHE = null;
async function getMessageColsSet() {
  if (MESSAGE_COLS_CACHE) return MESSAGE_COLS_CACHE;
  const cols = await dbAll("PRAGMA table_info(messages)");
  const set = new Set((cols || []).map((c) => c.name));
  MESSAGE_COLS_CACHE = set;
  return set;
}

async function findClientByPhone(toRaw) {
  const digits = phoneDigits10(toRaw);
  const plus1 = "+1" + digits;
  const one = "1" + digits;

  // Try common storage formats
  return await dbGet(
    `SELECT id, name, phone
     FROM clients
     WHERE phone = ?
        OR phone = ?
        OR phone = ?
        OR REPLACE(REPLACE(REPLACE(phone,'+',''),'(',''),')','') LIKE ?`,
    [digits, plus1, one, "%" + digits]
  );
}

router.post("/send-sms", requireInternalKey, async (req, res) => {
  try {
    const to = String(req.body.phone || "").trim();
    const text = String(req.body.text || "").trim();
    const sender = String(req.body.sender || "system").trim();

    if (!to || !text) return res.status(400).json({ message: "phone and text required" });
    if (!process.env.TWILIO_PHONE_NUMBER) return res.status(500).json({ message: "TWILIO_PHONE_NUMBER not set" });

    // 1) SEND TWILIO
    const tw = await twilioClient.messages.create({
      to,
      from: process.env.TWILIO_PHONE_NUMBER,
      body: text,
    });

    const timestamp = new Date().toISOString();

    // 2) FIND CLIENT
    const clientRow = await findClientByPhone(to);
    const clientId = clientRow?.id || null;
    const clientName = clientRow?.name || null;

    // 3) SAVE TO DB — ONLY COLUMNS THAT EXIST
    const cols = await getMessageColsSet();

    const insertCols = [];
    const params = [];

    if (cols.has("client_id")) {
      insertCols.push("client_id");
      params.push(clientId);
    }
    if (cols.has("sender")) {
      insertCols.push("sender");
      params.push(sender);
    }
    if (cols.has("text")) {
      insertCols.push("text");
      params.push(text);
    }
    if (cols.has("direction")) {
      insertCols.push("direction");
      params.push("outbound");
    }
    if (cols.has("timestamp")) {
      insertCols.push("timestamp");
      params.push(timestamp);
    }
    if (cols.has("external_id")) {
      insertCols.push("external_id");
      params.push(tw.sid);
    }

    // IMPORTANT: only include phone if the column actually exists
    if (cols.has("phone")) {
      insertCols.push("phone");
      params.push(to);
    }

    if (insertCols.length === 0) {
      return res.status(500).json({ message: "messages table has no recognized columns to insert into" });
    }

    const placeholders = insertCols.map(() => "?").join(", ");
    const sql = `INSERT INTO messages (${insertCols.join(", ")}) VALUES (${placeholders})`;

    // If this fails, we return 500 so Sheets shows FAILED (not SENT)
    await dbRun(sql, params);

    // 4) EMIT SOCKET EVENT
    if (req.io) {
      req.io.emit("newMessage", {
        client_id: clientId,
        client_name: clientName,
        sender,
        text,
        direction: "outbound",
        timestamp,
        external_id: tw.sid,
        phone: to,
      });
    }

    return res.json({ success: true, sid: tw.sid, client_id: clientId });
  } catch (err) {
    console.error("❌ /api/internal/send-sms error:", err);
    return res.status(500).json({ message: "Internal send failed", error: String(err?.message || err) });
  }
});

module.exports = router;
