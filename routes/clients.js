// routes/clients.js — CLEAN + SAFE (templates enqueue on PATCH status change)

const express = require("express");
const router = express.Router();
const db = require("../db");
const { enqueueTemplatesForClient } = require("../lib/enqueueTemplates");

// -------------------- HELPERS --------------------

function canonicalPhone(input) {
  if (!input) return "";
  const digits = String(input).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

function cleanPatchValue(v) {
  if (v === undefined || v === "") return undefined;
  return v;
}

function withTimeout(res, label, ms = 12000) {
  const t = setTimeout(() => {
    console.error(`❌ ${label} timed out after ${ms}ms`);
    if (!res.headersSent) res.status(504).json({ error: "Request timed out" });
  }, ms);
  return () => clearTimeout(t);
}

// -------------------- GET CLIENTS --------------------

router.get("/", (req, res) => {
  const clear = withTimeout(res, "GET /api/clients");

  db.all(
    `
    SELECT c.*, s.name AS status
    FROM clients c
    LEFT JOIN statuses s ON s.id = c.status_id
    ORDER BY
      CASE WHEN c.last_message_at IS NULL OR c.last_message_at = '' THEN 1 ELSE 0 END,
      datetime(c.last_message_at) DESC,
      c.id DESC
    `,
    [],
    (err, rows) => {
      clear();
      if (err) return res.status(500).json({ error: "Failed to load clients" });
      res.json(rows || []);
    }
  );
});

// -------------------- CREATE CLIENT --------------------

router.post("/", (req, res) => {
  const clear = withTimeout(res, "POST /api/clients");

  const { name, phone } = req.body || {};
  const cleanName = (name || "").trim();
  const cleanPhone = canonicalPhone(phone);

  if (!cleanName || cleanPhone.length !== 10) {
    clear();
    return res.status(400).json({ error: "Invalid name or phone" });
  }

  db.run(
    "INSERT INTO clients (name, phone) VALUES (?, ?)",
    [cleanName, cleanPhone],
    function (err) {
      clear();
      if (err) return res.status(500).json({ error: "Insert failed" });
      res.json({ id: this.lastID });
    }
  );
});

// -------------------- PATCH CLIENT (🔥 TEMPLATE TRIGGER HERE) --------------------

router.patch("/:id", (req, res) => {
  const clear = withTimeout(res, "PATCH /api/clients/:id");
  const id = req.params.id;

  db.get("SELECT * FROM clients WHERE id = ?", [id], (err, existing) => {
    if (err || !existing) {
      clear();
      return res.status(404).json({ error: "Client not found" });
    }

    const oldStatusId = existing.status_id;
    const body = req.body || {};

    const merged = {
      name: cleanPatchValue(body.name) ?? existing.name,
      phone:
        cleanPatchValue(body.phone) !== undefined
          ? canonicalPhone(body.phone)
          : existing.phone,
      status_id:
        cleanPatchValue(body.status_id) !== undefined
          ? body.status_id
          : existing.status_id,
    };

    db.run(
      `
      UPDATE clients
      SET name = ?, phone = ?, status_id = ?
      WHERE id = ?
      `,
      [merged.name, merged.phone, merged.status_id, id],
      (uErr) => {
        if (uErr) {
          clear();
          return res.status(500).json({ error: "Update failed" });
        }

        db.get(
          `
          SELECT c.*, s.name AS status
          FROM clients c
          LEFT JOIN statuses s ON s.id = c.status_id
          WHERE c.id = ?
          `,
          [id],
          async (fErr, updatedClient) => {
            clear();
            if (fErr) return res.status(500).json({ error: "Reload failed" });

            // 🔥 ACTUAL TEMPLATE TRIGGER
            if (
              body.status_id &&
              Number(oldStatusId) !== Number(body.status_id)
            ) {
              try {
                await enqueueTemplatesForClient(updatedClient);
              } catch (e) {
                console.error("❌ Template enqueue failed:", e.message);
              }
            }

            res.json(updatedClient);
          }
        );
      }
    );
  });
});

// -------------------- DELETE CLIENT --------------------

router.delete("/:id", (req, res) => {
  const clear = withTimeout(res, "DELETE /api/clients/:id");

  db.run("DELETE FROM clients WHERE id = ?", [req.params.id], (err) => {
    clear();
    if (err) return res.status(500).json({ error: "Delete failed" });
    res.json({ success: true });
  });
});

module.exports = router;
