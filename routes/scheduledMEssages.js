// routes/scheduledMEssages.js
// Scheduled message queue (unix millis)

const express = require("express");
const router = express.Router();
const db = require("../db");

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseSendTime(input) {
  const ms = Date.parse(input);
  return Number.isFinite(ms) ? ms : null;
}

// ----------------------------------------------------------------
// GET /api/scheduled_messages
// ----------------------------------------------------------------
router.get("/", (req, res) => {
  db.all(
    "SELECT * FROM scheduled_messages ORDER BY send_time DESC",
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    }
  );
});

// ----------------------------------------------------------------
// POST /api/scheduled_messages
// body: { client_id, send_time (ISO), message }
// ----------------------------------------------------------------
router.post("/", (req, res) => {
  const client_id = toInt(req.body.client_id);
  const send_time = parseSendTime(req.body.send_time);
  const message = String(req.body.message || "").trim();

  if (!client_id) return res.status(400).json({ error: "client_id required" });
  if (!send_time) return res.status(400).json({ error: "Invalid send_time" });
  if (!message) return res.status(400).json({ error: "message required" });

  const now = Date.now();

  db.run(
    `
    INSERT INTO scheduled_messages
    (client_id, send_time, message, status, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?)
    `,
    [client_id, send_time, message, now, now],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });

      db.get(
        "SELECT * FROM scheduled_messages WHERE id = ?",
        [this.lastID],
        (err2, row) => {
          if (err2) return res.status(500).json({ error: err2.message });
          res.json({ success: true, scheduled_message: row });
        }
      );
    }
  );
});

// ----------------------------------------------------------------
// POST /api/scheduled_messages/:id/cancel
// ----------------------------------------------------------------
router.post("/:id/cancel", (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });

  db.run(
    `
    UPDATE scheduled_messages
    SET status='canceled', updated_at=?
    WHERE id=?
    `,
    [Date.now(), id],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

module.exports = router;
