// routes/messages.js

const express = require("express");
const router = express.Router();
const twilio = require("twilio");
const db = require("../db");
const normalizePhone = require("../utils/normalizePhone");

// Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const twilioFrom = process.env.TWILIO_PHONE_NUMBER;

/**
 * GET /api/messages
 * Query:
 *   - ?client_id=123  OR
 *   - ?phone=6025551234
 * Returns newest-last (ASC) for chat rendering
 */
router.get("/", (req, res) => {
  const clientId = req.query.client_id ? String(req.query.client_id).trim() : "";
  const phoneRaw = req.query.phone ? String(req.query.phone).trim() : "";
  const phone = phoneRaw ? normalizePhone(phoneRaw) : "";

  if (!clientId && !phone) {
    return res.status(400).json({ ok: false, error: "Provide client_id or phone" });
  }

  const runQueryByClientId = (id) => {
    db.all(
      `
      SELECT id, client_id, sender, text, direction, timestamp, external_id
      FROM messages
      WHERE client_id = ?
      ORDER BY datetime(timestamp) ASC, id ASC
      `,
      [id],
      (err, rows) => {
        if (err) {
          console.error("❌ messages fetch failed:", err.message);
          return res.status(500).json({ ok: false, error: err.message });
        }
        res.json(rows || []);
      }
    );
  };

  if (clientId) return runQueryByClientId(clientId);

  // If phone provided, translate to client_id first
  db.get(
    "SELECT id FROM clients WHERE phone = ?",
    [phone.replace(/\D/g, "").slice(-10)],
    (err, row) => {
      if (err) {
        console.error("❌ client lookup by phone failed:", err.message);
        return res.status(500).json({ ok: false, error: err.message });
      }
      if (!row) return res.json([]);
      runQueryByClientId(row.id);
    }
  );
});

/**
 * GET /api/messages/conversation/:client_id
 * Backward compatible
 */
router.get("/conversation/:client_id", (req, res) => {
  const clientId = req.params.client_id;

  db.all(
    `
    SELECT id, client_id, sender, text, direction, timestamp, external_id
    FROM messages
    WHERE client_id = ?
    ORDER BY datetime(timestamp) ASC, id ASC
    `,
    [clientId],
    (err, rows) => {
      if (err) {
        console.error("❌ DB error:", err.message);
        return res.status(500).json([]);
      }
      res.json(rows || []);
    }
  );
});

/**
 * POST /api/messages/send
 * Sends an SMS (Twilio) AND saves message in DB AND emits socket event
 * Body: { client_id?, phone?, text, sender? }
 */
router.post("/send", async (req, res) => {
  try {
    const text = (req.body.text || "").trim();
    const sender = (req.body.sender || "agent").trim();
const userId = req.user?.id || null;

    const clientIdRaw = req.body.client_id ? String(req.body.client_id).trim() : "";
    const phoneRaw = req.body.phone ? String(req.body.phone).trim() : "";

    if (!text) {
      return res.status(400).json({ ok: false, error: "Missing text" });
    }

    // Resolve client
    const clientRow = await new Promise((resolve, reject) => {
      if (clientIdRaw) {
        db.get("SELECT id, phone, name FROM clients WHERE id = ?", [clientIdRaw], (err, row) => {
          if (err) return reject(err);
          resolve(row || null);
        });
      } else {
        const canon10 = phoneRaw ? String(phoneRaw).replace(/\D/g, "").slice(-10) : "";
        if (!canon10) return resolve(null);

        db.get("SELECT id, phone, name FROM clients WHERE phone = ?", [canon10], (err, row) => {
          if (err) return reject(err);
          resolve(row || null);
        });
      }
    });

    if (!clientRow) {
      return res.status(404).json({ ok: false, error: "Client not found" });
    }

    const client_id = clientRow.id;

    // Twilio needs E.164; clientRow.phone is canonical 10 digits
    const to = normalizePhone(clientRow.phone);

    if (!to) {
      return res.status(400).json({
        ok: false,
        error: "Client phone is invalid. Must be a real 10-digit US number.",
      });
    }

    // Send via Twilio
    const sent = await twilioClient.messages.create({
      from: twilioFrom,
      to,
      body: text,
    });

    // Save to DB
    const ts = new Date().toISOString();

    const messageId = await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO messages (client_id, sender, text, direction, timestamp, external_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [client_id, sender, text, "outbound", ts, sent.sid],
        function (err) {
          if (err) return reject(err);
          resolve(this.lastID);
        }
      );
    });

    // ✅ Persist “phone-like ordering” (so refresh keeps correct order)
    db.run(
      `UPDATE clients SET last_message_at = ?, last_message_text = ? WHERE id = ?`,
      [ts, text, client_id],
      (e) => {
        if (e) console.error("❌ Update last_message_at failed:", e.message);
      }
    );

    // Emit live update
    const payload = {
      id: messageId,
      client_id,
      client_name: clientRow.name || undefined,
      phone: to,
      sender,
      text,
      direction: "outbound",
      timestamp: ts,
      external_id: sent.sid,
    };

    if (req.io) {
      req.io.emit("newMessage", payload);
      req.io.emit("message", payload);
    }

    return res.json({ ok: true, id: messageId, client_id, sid: sent.sid });
  } catch (err) {
    console.error("❌ POST /api/messages/send failed:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message || String(err),
    });
  }
});

/**
 * POST /api/messages/note
 * Save an internal note (does NOT send SMS)
 * Body: { phone, text, sender? }
 */
router.post("/note", (req, res) => {
  const phoneRaw = req.body.phone || "";
  const canon10 = String(phoneRaw).replace(/\D/g, "").slice(-10);
  const text = (req.body.text || "").trim();
  const sender = (req.body.sender || "agent").trim();

  if (!canon10 || !text) {
    return res.status(400).json({ ok: false, error: "Missing phone or text" });
  }

  db.get("SELECT id, name FROM clients WHERE phone = ?", [canon10], (err, row) => {
    if (err) {
      console.error("❌ client lookup failed:", err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
    if (!row) return res.status(404).json({ ok: false, error: "Client not found" });

    const ts = new Date().toISOString();

    db.run(
      "INSERT INTO messages (client_id, sender, text, direction, timestamp, external_id) VALUES (?, ?, ?, ?, ?, ?)",
      [row.id, sender, text, "outbound", ts, null],
      function (msgErr) {
        if (msgErr) {
          console.error("❌ note insert failed:", msgErr.message);
          return res.status(500).json({ ok: false, error: msgErr.message });
        }

        // ✅ Persist ordering for notes too
        db.run(
          `UPDATE clients SET last_message_at = ?, last_message_text = ? WHERE id = ?`,
          [ts, text, row.id],
          (e) => {
            if (e) console.error("❌ Update last_message_at failed:", e.message);
          }
        );

        const payload = {
          id: this.lastID,
          client_id: row.id,
          client_name: row.name || undefined,
          phone: `+1${canon10}`,
          sender,
          text,
          direction: "outbound",
          timestamp: ts,
          external_id: null,
        };

        if (req.io) {
          req.io.emit("newMessage", payload);
          req.io.emit("message", payload);
        }

        res.json({ ok: true, id: this.lastID, client_id: row.id });
      }
    );
  });
});

module.exports = router;

