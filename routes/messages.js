const express = require("express");
const router = express.Router();
const db = require("../db");
const normalizePhone = require("../utils/normalizePhone");
const twilio = require("twilio");

/**
 * Twilio client (server-side)
 */
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
 * Returns oldest-first (ASC) for chat rendering
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
  db.get("SELECT id FROM clients WHERE phone = ?", [phone], (err, row) => {
    if (err) {
      console.error("❌ client lookup by phone failed:", err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
    if (!row) return res.json([]); // no client yet
    runQueryByClientId(row.id);
  });
});

/**
 * GET /api/messages/conversation/:client_id
 * (kept for backward compatibility with your current React)
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
 * POST /api/messages/note
 * Save an internal note (does NOT send SMS)
 * Body: { phone, text, sender? }
 */
router.post("/note", (req, res) => {
  const phone = normalizePhone(req.body.phone || "");
  const text = (req.body.text || "").trim();
  const sender = (req.body.sender || "agent").trim();

  if (!phone || !text) {
    return res.status(400).json({ ok: false, error: "Missing phone or text" });
  }

  db.get("SELECT id FROM clients WHERE phone = ?", [phone], (err, row) => {
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

        if (req.io) {
          req.io.emit("message", {
            id: this.lastID,
            client_id: row.id,
            phone,
            sender,
            text,
            direction: "outbound",
            timestamp: ts,
            external_id: null,
          });
        }

        res.json({ ok: true, id: this.lastID, client_id: row.id, phone });
      }
    );
  });
});

/**
 * POST /api/messages/send
 * Sends an outbound SMS via Twilio + saves to DB + emits socket event
 *
 * Body:
 *   { client_id, text, sender? }
 * OR
 *   { phone, text, sender? }
 */
router.post("/send", async (req, res) => {
  try {
    const text = (req.body.text || "").trim();
    const sender = (req.body.sender || "agent").trim();

    const clientIdRaw = req.body.client_id ? String(req.body.client_id).trim() : "";
    const phoneRaw = req.body.phone ? String(req.body.phone).trim() : "";
    const phoneNormalized = phoneRaw ? normalizePhone(phoneRaw) : "";

    if (!text) return res.status(400).json({ ok: false, error: "Missing text" });

    const resolveClient = () =>
      new Promise((resolve, reject) => {
        if (clientIdRaw) {
          db.get("SELECT id, phone FROM clients WHERE id = ?", [clientIdRaw], (err, row) => {
            if (err) return reject(err);
            resolve(row || null);
          });
        } else if (phoneNormalized) {
          db.get("SELECT id, phone FROM clients WHERE phone = ?", [phoneNormalized], (err, row) => {
            if (err) return reject(err);
            resolve(row || null);
          });
        } else {
          resolve(null);
        }
      });

    const clientRow = await resolveClient();
    if (!clientRow) {
      return res.status(404).json({ ok: false, error: "Client not found" });
    }

    const client_id = clientRow.id;
    const to = normalizePhone(clientRow.phone);

    if (!to) {
  return res.status(400).json({
    ok: false,
    error: "Client phone is invalid. Must be a real 10-digit US number."
  });
}

    if (!to) return res.status(400).json({ ok: false, error: "Client phone is invalid" });
    if (!twilioFrom) return res.status(500).json({ ok: false, error: "TWILIO_PHONE_NUMBER missing" });

    // Send via Twilio
    const sent = await twilioClient.messages.create({
      from: twilioFrom,
      to,
      body: text,
    });

    const ts = new Date().toISOString();

    const insertId = await new Promise((resolve, reject) => {
      db.run(
        "INSERT INTO messages (client_id, sender, text, direction, timestamp, external_id) VALUES (?, ?, ?, ?, ?, ?)",
        [client_id, sender, text, "outbound", ts, sent.sid],
        function (err) {
          if (err) return reject(err);
          resolve(this.lastID);
        }
      );
    });

    if (req.io) {
      req.io.emit("message", {
        id: insertId,
        client_id,
        phone: to,
        sender,
        text,
        direction: "outbound",
        timestamp: ts,
        external_id: sent.sid,
      });
    }

    return res.json({
      ok: true,
      message: {
        id: insertId,
        client_id,
        phone: to,
        sender,
        text,
        direction: "outbound",
        timestamp: ts,
        external_id: sent.sid,
      },
    });
  } catch (err) {
    console.error("❌ POST /api/messages/send failed:", err);
    return res.status(500).json({ ok: false, error: "Server error sending message" });
  }
});

module.exports = router;


