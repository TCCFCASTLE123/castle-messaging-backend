// routes/scheduledMEssages.js  <-- KEEP THIS EXACT FILENAME (capital E)

const express = require("express");
const router = express.Router();
const db = require("../db");

// ---- helpers ----
function nowIso() {
  return new Date().toISOString();
}

function isValidIsoDate(s) {
  const d = new Date(s);
  return !!s && !isNaN(d.getTime());
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ============================================================================
// GET /api/scheduled-messages?client_id=123
// (keeps your original behavior)
// ============================================================================
router.get("/", (req, res) => {
  const clientId = req.query.client_id;

  if (clientId) {
    db.all(
      "SELECT * FROM scheduled_messages WHERE client_id = ? ORDER BY send_time DESC",
      [clientId],
      (err, rows) => {
        if (err) return res.status(500).json({ error: "DB error", details: err.message });
        res.json(rows || []);
      }
    );
  } else {
    db.all("SELECT * FROM scheduled_messages ORDER BY send_time DESC", [], (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error", details: err.message });
      res.json(rows || []);
    });
  }
});

// ============================================================================
// POST /api/scheduled-messages
// Create one scheduled message in the queue
// body: { client_id, send_time, message, status?, template_key?, rule_key?, step?, meta? }
// Notes:
// - This expects your table has a "message" column. If yours is "body", change SQL + field.
// - "status" is optional; defaults to "pending".
// ============================================================================
router.post("/", (req, res) => {
  const client_id = toInt(req.body.client_id);
  const send_time = req.body.send_time;
  const message = String(req.body.message || "").trim();

  const status = String(req.body.status || "pending").trim();
  const template_key = req.body.template_key ? String(req.body.template_key).trim() : null;
  const rule_key = req.body.rule_key ? String(req.body.rule_key).trim() : null;
  const step = req.body.step != null ? toInt(req.body.step) : null;
  const meta = req.body.meta != null ? JSON.stringify(req.body.meta) : null;

  if (!client_id) return res.status(400).json({ error: "client_id is required" });
  if (!isValidIsoDate(send_time)) return res.status(400).json({ error: "send_time must be a valid ISO timestamp" });
  if (!message) return res.status(400).json({ error: "message is required" });

  const created_at = nowIso();

  // If your scheduled_messages table doesn't have some of these columns yet,
  // remove them from the INSERT and we’ll add migrations next.
  const sql = `
    INSERT INTO scheduled_messages
      (client_id, send_time, message, status, template_key, rule_key, step, meta, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  db.run(
    sql,
    [client_id, send_time, message, status, template_key, rule_key, step, meta, created_at, created_at],
    function (err) {
      if (err) return res.status(500).json({ error: "DB error", details: err.message });
      db.get("SELECT * FROM scheduled_messages WHERE id = ?", [this.lastID], (err2, row) => {
        if (err2) return res.status(500).json({ error: "DB error", details: err2.message });
        res.json({ success: true, scheduled_message: row });
      });
    }
  );
});

// ============================================================================
// PATCH /api/scheduled-messages/:id
// Update queued item (time/message/status/template fields)
// body can include: { send_time?, message?, status?, template_key?, rule_key?, step?, meta? }
// ============================================================================
router.patch("/:id", (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });

  const updates = [];
  const params = [];

  if (req.body.send_time != null) {
    if (!isValidIsoDate(req.body.send_time)) return res.status(400).json({ error: "send_time must be valid ISO" });
    updates.push("send_time = ?");
    params.push(req.body.send_time);
  }

  if (req.body.message != null) {
    const msg = String(req.body.message || "").trim();
    if (!msg) return res.status(400).json({ error: "message cannot be blank" });
    updates.push("message = ?");
    params.push(msg);
  }

  if (req.body.status != null) {
    updates.push("status = ?");
    params.push(String(req.body.status).trim());
  }

  if (req.body.template_key != null) {
    updates.push("template_key = ?");
    params.push(req.body.template_key ? String(req.body.template_key).trim() : null);
  }

  if (req.body.rule_key != null) {
    updates.push("rule_key = ?");
    params.push(req.body.rule_key ? String(req.body.rule_key).trim() : null);
  }

  if (req.body.step != null) {
    updates.push("step = ?");
    params.push(req.body.step === "" ? null : toInt(req.body.step));
  }

  if (req.body.meta != null) {
    updates.push("meta = ?");
    params.push(req.body.meta === null ? null : JSON.stringify(req.body.meta));
  }

  if (updates.length === 0) return res.status(400).json({ error: "No fields to update" });

  updates.push("updated_at = ?");
  params.push(nowIso());

  params.push(id);

  const sql = `UPDATE scheduled_messages SET ${updates.join(", ")} WHERE id = ?`;

  db.run(sql, params, function (err) {
    if (err) return res.status(500).json({ error: "DB error", details: err.message });
    db.get("SELECT * FROM scheduled_messages WHERE id = ?", [id], (err2, row) => {
      if (err2) return res.status(500).json({ error: "DB error", details: err2.message });
      res.json({ success: true, scheduled_message: row });
    });
  });
});

// ============================================================================
// POST /api/scheduled-messages/:id/cancel
// Marks as canceled (does not delete)
// ============================================================================
router.post("/:id/cancel", (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });

  db.run(
    "UPDATE scheduled_messages SET status = 'canceled', updated_at = ? WHERE id = ?",
    [nowIso(), id],
    function (err) {
      if (err) return res.status(500).json({ error: "DB error", details: err.message });
      res.json({ success: true });
    }
  );
});

// ============================================================================
// DELETE /api/scheduled-messages/:id
// Hard delete (optional; often you’ll prefer cancel)
// ============================================================================
router.delete("/:id", (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });

  db.run("DELETE FROM scheduled_messages WHERE id = ?", [id], function (err) {
    if (err) return res.status(500).json({ error: "DB error", details: err.message });
    res.json({ success: true, deleted: this.changes || 0 });
  });
});

// ============================================================================
// GET /api/scheduled-messages/due?limit=50
// Returns pending messages due to send (for a worker/cron)
// ============================================================================
router.get("/due/list", (req, res) => {
  const limit = Math.min(Math.max(toInt(req.query.limit) || 50, 1), 500);

  db.all(
    `
    SELECT *
    FROM scheduled_messages
    WHERE status = 'pending'
      AND send_time <= ?
    ORDER BY send_time ASC
    LIMIT ?
  `,
    [nowIso(), limit],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error", details: err.message });
      res.json(rows || []);
    }
  );
});

module.exports = router;
