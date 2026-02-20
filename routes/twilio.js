const express = require("express");
const router = express.Router();
const twilio = require("twilio");
const db = require("../db");
const { sendEmail } = require("../utils/mailer");
const MessagingResponse = twilio.twiml.MessagingResponse;

// ----------------------------
// Staff routing map + helpers
// ----------------------------
const STAFF = {
  avh: { name: "Abby Heller", phone: "6232173411", email: "abby@mayestelles.com" },
  bag: { name: "Brenda Garcia", phone: "4802215174", email: "brenda@mayestelles.com" },
  cc:  { name: "Chris Castle", phone: "8588294287", email: "chris@mayestelles.com" },
  clc: { name: "Cassandra Castle", phone: "6027960878", email: "cassandra@mayestelles.com" },
  dt:  { name: "Dean Turnbow", phone: "6026976730", email: "dean@mayestelles.com" },
  ild: { name: "Itzayani Luque", phone: "6233135868", email: "itzy@mayestelles.com" },
  jmp: { name: "Janny Mancinas", phone: "4803528900", email: "janny@mayestelles.com" },
  jh:  { name: "Josh Hall", phone: "6024603599", email: "josh@mayestelles.com" },
  jwg: { name: "Jacob Gray", phone: "4808260509", email: "jacob@mayestelles.com" },
  trd: { name: "Tyler Durham", phone: "6027403867", email: "tyler@mayestelles.com" },
  rp:  { name: "Rebeca Perez", phone: "6196323950", email: "rperez@mayestelles.com" },
};


// Aliases → staff code (helps match sheet values like "Gabe", "Gabriel Cano", etc.)
const STAFF_ALIASES = {
  avh: "avh",
  abby: "avh",
  "abby heller": "avh",

  cc: "cc",
  chris: "cc",
  "chris castle": "cc",

  clc: "clc",
  cass: "clc",
  cassandra: "clc",
  "cassandra castle": "clc",

  dt: "dt",
  dean: "dt",
  "dean turnbow": "dt",

  bag: "bag",
  brenda: "bag",
  "brenda garcia": "bag",

  ild: "ild",
  itzayani: "ild",
  "itzayani luque": "ild",

  jmp: "jmp",
  janny: "jmp",
  "janny mancinas": "jmp",

  jh: "jh",
  josh: "jh",
  "josh hall": "jh",

  jwg: "jwg",
  jacob: "jwg",
  "jacob gray": "jwg",

  trd: "trd",
  tyler: "trd",
  "tyler durham": "trd",

  rp: "rp",
  rebeca: "rp",
  "rebeca perez": "rp",
};

function normalizeName(s) {
  return (s || "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ");
}

function toE164US(digitsOrFormatted) {
  const d = (digitsOrFormatted || "").replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return "";
}

// Generic staff picker by name/code (for IC / Appt Setter fallback)
function pickStaffE164FromName(value) {
  const raw = normalizeName(value);
  if (!raw) return "";

  const compact = raw.replace(/\s/g, "");
  const directCode = STAFF_ALIASES[compact] || compact;
  if (STAFF[directCode]) return toE164US(STAFF[directCode].phone);

  const codeFull = STAFF_ALIASES[raw];
  if (codeFull && STAFF[codeFull]) return toE164US(STAFF[codeFull].phone);

  const first = raw.split(" ")[0];
  const codeFirst = STAFF_ALIASES[first];
  if (codeFirst && STAFF[codeFirst]) return toE164US(STAFF[codeFirst].phone);

  return "";
}
function pickStaffEmailFromName(value) {
  const raw = normalizeName(value);
  if (!raw) return "";

  const compact = raw.replace(/\s/g, "");
  const directCode = STAFF_ALIASES[compact] || compact;
  if (STAFF[directCode]?.email) return STAFF[directCode].email;

  const codeFull = STAFF_ALIASES[raw];
  if (codeFull && STAFF[codeFull]?.email) return STAFF[codeFull].email;

  const first = raw.split(" ")[0];
  const codeFirst = STAFF_ALIASES[first];
  if (codeFirst && STAFF[codeFirst]?.email) return STAFF[codeFirst].email;

  return "";
}


// Cooldown per client (avoid spamming staff if client sends many texts quickly)
const ALERT_COOLDOWN_MS = Number(process.env.INBOUND_ALERT_COOLDOWN_MS || 60_000);
const lastAlertByClientId = new Map(); // client_id -> timestamp ms

function canSendAlertNow(client_id) {
  const now = Date.now();
  const last = lastAlertByClientId.get(client_id) || 0;
  if (now - last < ALERT_COOLDOWN_MS) return false;
  lastAlertByClientId.set(client_id, now);
  return true;
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;

// If creds exist, we can send staff alert texts from backend
const twilioClient =
  twilioAccountSid && twilioAuthToken ? twilio(twilioAccountSid, twilioAuthToken) : null;

// ----------------------------
// Existing helpers
// ----------------------------
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
    const numMedia = Number(req.body.NumMedia || 0);
let mediaUrl = null;

if (numMedia > 0) {
  const twilioMediaUrl = req.body.MediaUrl0;

  const axios = require("axios");
  const path = require("path");
  const fs = require("fs");

  const ext = req.body.MediaContentType0?.includes("png")
    ? ".png"
    : ".jpg";

  const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
  const savePath = `/var/data/uploads/${filename}`;

  const response = await axios.get(twilioMediaUrl, {
    responseType: "stream",
    auth: {
      username: process.env.TWILIO_ACCOUNT_SID,
      password: process.env.TWILIO_AUTH_TOKEN,
    },
  });

  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(savePath);
    response.data.pipe(stream);
    stream.on("finish", resolve);
    stream.on("error", reject);
  });

  mediaUrl = `/uploads/${filename}`;
}


    const sid = req.body.MessageSid || null;

    if (!fromCanon || fromCanon.length !== 10) {
  const twiml = new MessagingResponse();
  return res.status(200).send(twiml.toString());
}

    const clientRow = await new Promise((resolve, reject) => {
      db.get(
        "SELECT id, phone, name, appt_setter, ic, intake_coordinator FROM clients WHERE phone = ?",
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
    `INSERT INTO messages
     (client_id, sender, text, image_url, direction, timestamp, external_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      client_id,
      "client",
      body || (mediaUrl ? "[Image]" : ""),
      mediaUrl || null,
      "inbound",
      ts,
      sid,
    ],
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
      text: body || (mediaUrl ? "[Image]" : ""),
image_url: mediaUrl || null,
      direction: "inbound",
      timestamp: ts,
      external_id: sid,
    };

    if (req.io) {
      req.io.emit("newMessage", payload);
      req.io.emit("message", payload);
    }
// -------------------------------------------------
//
    // -------------------------------------------------
// Staff Alerts (SMS + Email)
// -------------------------------------------------
try {
  if (canSendAlertNow(client_id)) {

    const routingClient =
      clientRow ||
      (await dbGet(
        "SELECT id, name, phone, appt_setter, ic, intake_coordinator FROM clients WHERE id = ?",
        [client_id]
      ));

    const lastOut = await dbGet(
      `SELECT user_id
       FROM messages
       WHERE client_id = ?
         AND direction = 'outbound'
         AND user_id IS NOT NULL
       ORDER BY timestamp DESC
       LIMIT 1`,
      [client_id]
    );

    let staffPhone = "";
    let staffEmail = "";

    if (lastOut?.user_id) {
      const user = await dbGet(
        "SELECT username, cell_phone FROM users WHERE id = ?",
        [lastOut.user_id]
      );

      if (user?.cell_phone) {
        staffPhone = toE164US(user.cell_phone);
      }

      if (user?.username) {
        staffEmail = pickStaffEmailFromName(user.username);
      }
    }

    if (!staffPhone) {
      staffPhone =
        pickStaffE164FromName(routingClient?.ic) ||
        pickStaffE164FromName(routingClient?.intake_coordinator) ||
        "";
    }

    if (!staffEmail) {
      staffEmail =
        pickStaffEmailFromName(routingClient?.ic) ||
        pickStaffEmailFromName(routingClient?.intake_coordinator) ||
        "";
    }

    if (!staffPhone) {
      staffPhone = pickStaffE164FromName(routingClient?.appt_setter) || "";
    }

    if (!staffEmail) {
      staffEmail = pickStaffEmailFromName(routingClient?.appt_setter) || "";
    }

    const baseUrl = (process.env.FRONTEND_URL || "").trim().replace(/\/+$/, "");
    const link = baseUrl ? `${baseUrl}/inbox?clientId=${client_id}` : "";
    const preview = body.slice(0, 300);

    // SMS
    if (twilioClient && staffPhone) {
      const alertText =
        `${client_name || routingClient?.name || fromCanon} sent you a text:\n\n"${preview}"` +
        (link ? `\n\nOpen: ${link}` : "");

      const msg = {
        to: staffPhone,
        body: alertText,
      };

      if (process.env.TWILIO_INTERNAL_MESSAGING_SERVICE_SID) {
        msg.messagingServiceSid = process.env.TWILIO_INTERNAL_MESSAGING_SERVICE_SID;
      } else {
        msg.from =
          process.env.TWILIO_INTERNAL_FROM ||
          process.env.TWILIO_PHONE_NUMBER ||
          "";
      }

      await twilioClient.messages.create(msg);
      console.log("📱 Staff SMS alert sent:", staffPhone);
    }

    // Email
    if (staffEmail) {
      await sendEmail({
        to: staffEmail,
        subject: `New message from ${client_name || "Client"}`,
        text:
          `New inbound SMS from ${client_name || "Client"}:\n\n` +
          `"${preview}"\n\n` +
          `Open conversation:\n${link || "(open CRM)"}`,
      });

      console.log("📧 Staff email alert sent:", staffEmail);
    }
  }
} catch (notifyErr) {
  console.error("⚠️ Staff alert failed (non-fatal):", notifyErr);
}

const twiml = new MessagingResponse();
return res.status(200).send(twiml.toString());
});

module.exports = router;
















