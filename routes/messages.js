const express = require("express");
const router = express.Router();
const db = require("../db");
const normalizePhone = require("../utils/normalizePhone");

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
      SELECT id, client_id, sender, text, direction, timestamp, external_id, phone
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
    if (!row) return res.json([]); // no client yet, return empty history
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
    SELECT id, client_id, sender, text, direction, timestamp, external_id, phone
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
      "INSERT INTO messages (client_id, sender, text, direction, timestamp, external_id, phone) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [row.id, sender, text, "outbound", ts, null, phone],
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
            twilio_sid: null,
          });
        }

        res.json({ ok: true, id: this.lastID, client_id: row.id, phone });
      }
    );
  });
});

module.exports = router;
