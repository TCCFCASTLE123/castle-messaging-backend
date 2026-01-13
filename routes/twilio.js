const express = require("express");
const router = express.Router();
const twilio = require("twilio");
const db = require("../db");

const MessagingResponse = twilio.twiml.MessagingResponse;

// Match the exact same format you store in clients.phone (10 digits)
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

/**
 * POST /api/twilio/inbound
 * Twilio sends application/x-www-form-urlencoded
 * Body includes: From, To, Body, MessageSid
 */
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
    const fromE164 = toE164FromCanonical(fromCanon); // for UI display if you want
    const body = (req.body.Body || "").trim();
    const sid = req.body.MessageSid || null;

    if (!fromCanon || fromCanon.length !== 10 || !body) {
      console.log("⚠️ Inbound missing/invalid From or Body:", {
        fromCanon,
        bodyLen: body?.length || 0,
      });
      const twiml = new MessagingResponse();
      return res.status(200).send(twiml.toString());
    }

    // 1) Find client by canonical phone (10 digits)
    const clientRow = await new Promise((resolve, reject) => {
      db.get(
        "SELECT id, phone, name FROM clients WHERE phone = ?",
        [fromCanon],
        (err, row) => {
          if (err) return reject(err);
          resolve(row || null);
        }
      );
    });

    let client_id = clientRow?.id;

    // 2) If not found, create placeholder using canonical phone (matches your schema)
    if (!client_id) {
      const createdAt = new Date().toISOString();
      client_id = await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO clients (name, phone, created_at)
           VALUES (?, ?, ?)`,
          [`Inbound ${fromE164 || fromCanon}`, fromCanon, createdAt],
          function (err) {
            if (err) return reject(err);
            resolve(this.lastID);
          }
        );
      });

      console.log("✅ Created placeholder client for inbound:", {
        client_id,
        phone: fromCanon,
      });
    }

    // 3) Insert inbound message (your messages table has no phone column)
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

    // 4) Emit for live UI update
    if (req.io) {
      req.io.emit("message", {
        id: messageId,
        client_id,
        phone: fromE164 || fromCanon, // show +1... in UI, fallback to digits
        phone_canonical: fromCanon,
        sender: "client",
        text: body,
        direction: "inbound",
        timestamp: ts,
        external_id: sid,
      });
    } else {
      console.log("⚠️ req.io not present; cannot emit live update");
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
