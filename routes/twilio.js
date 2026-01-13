const express = require("express");
const router = express.Router();
const twilio = require("twilio");
const db = require("../db");
const normalizePhone = require("../utils/normalizePhone");

const MessagingResponse = twilio.twiml.MessagingResponse;

/**
 * POST /api/twilio/inbound
 * Twilio sends application/x-www-form-urlencoded
 * Body includes: From, To, Body, MessageSid
 */
router.post("/inbound", async (req, res) => {
  // Always respond with TwiML (Twilio-friendly)
  res.type("text/xml");

  try {
    // ✅ log FIRST so we can see hits even if Twilio retries
    console.log("📩 INBOUND HIT:", {
      From: req.body.From,
      To: req.body.To,
      Body: req.body.Body,
      MessageSid: req.body.MessageSid,
    });

    const from = normalizePhone(req.body.From || "");
    const body = (req.body.Body || "").trim();
    const sid = req.body.MessageSid || null;

    if (!from || !body) {
      console.log("⚠️ Inbound missing From or Body (normalized From:", from, ")");
      const twiml = new MessagingResponse();
      return res.status(200).send(twiml.toString());
    }

    // 1) Find client by phone, or create a minimal placeholder client
    const clientRow = await new Promise((resolve, reject) => {
      db.get("SELECT id, phone, name FROM clients WHERE phone = ?", [from], (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      });
    });

    let client_id = clientRow?.id;

    if (!client_id) {
      const createdAt = new Date().toISOString();
      client_id = await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO clients (name, phone, created_at)
           VALUES (?, ?, ?)`,
          [`Inbound ${from}`, from, createdAt],
          function (err) {
            if (err) return reject(err);
            resolve(this.lastID);
          }
        );
      });

      console.log("✅ Created placeholder client for inbound:", { client_id, phone: from });
    }

    // 2) Insert inbound message (matches your schema: no phone column)
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

    // 3) Emit for live UI update
    if (req.io) {
      req.io.emit("message", {
        id: messageId,
        client_id,
        phone: from, // useful for UI, even if not stored in messages table
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
    return res.status(200).send(twiml.toString()); // still 200 so Twilio doesn't hammer retries
  }
});

module.exports = router;
