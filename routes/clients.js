// routes/clients.js — HARDENED (no hanging requests)

const express = require("express");
const router = express.Router();
const db = require("../db");

function canonicalPhone(input) {
  if (!input) return "";
  const digits = String(input).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

// Optional: prevents "pending forever" if sqlite is locked
function withTimeout(res, label, ms = 12000) {
  const t = setTimeout(() => {
    console.error(`❌ ${label} timed out after ${ms}ms`);
    if (!res.headersSent) res.status(504).json({ error: "Request timed out" });
  }, ms);
  return () => clearTimeout(t);
}

/**
 * GET /api/clients
 */
router.get("/", (req, res) => {
  const clear = withTimeout(res, "GET /api/clients");

  db.all(
    `
      SELECT c.*, s.name AS status_name
      FROM clients c
      LEFT JOIN statuses s ON c.status_id = s.id
      ORDER BY c.id DESC
    `,
    [],
    (err, rows) => {
      clear();
      if (err) {
        console.error("❌ GET clients failed:", err);
        return res.status(500).json({ error: "Failed to load clients" });
      }
      return res.json(rows || []);
    }
  );
});

/**
 * POST /api/clients
 */
router.post("/", (req, res) => {
  const clear = withTimeout(res, "POST /api/clients");

  try {
    const {
      name,
      phone,
      email,
      notes,
      language,
      office,
      case_type,
      AppointmentScheduledDate,
    } = req.body || {};

    const cleanName = (name || "").trim();
    const cleanPhone = canonicalPhone(phone);

    if (!cleanName) {
      clear();
      return res.status(400).json({ error: "Name is required" });
    }
    if (!cleanPhone || cleanPhone.length < 10) {
      clear();
      return res.status(400).json({ error: "Phone number is required (10 digits)" });
    }

    // If your DB has UNIQUE(phone), this prevents duplicates cleanly
    db.get("SELECT id FROM clients WHERE phone = ?", [cleanPhone], (lookupErr, row) => {
      if (lookupErr) {
        clear();
        console.error("❌ Client lookup failed:", lookupErr);
        return res.status(500).json({ error: "Client lookup failed" });
      }

      if (row && row.id) {
        clear();
        return res.status(409).json({ error: "That phone number already exists as a client." });
      }

      db.run(
        `
          INSERT INTO clients
          (name, phone, email, notes, language, office, case_type, appointment_datetime)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          cleanName,
          cleanPhone,
          email || null,
          notes || null,
          language || "English",
          office || null,
          case_type || null,
          AppointmentScheduledDate || null,
        ],
        function (insertErr) {
          if (insertErr) {
            clear();
            console.error("❌ Client insert failed:", insertErr);
            return res.status(500).json({ error: "Failed to save client" });
          }

          const newId = this.lastID;

          db.get("SELECT * FROM clients WHERE id = ?", [newId], (getErr, newRow) => {
            clear();
            if (getErr) {
              console.error("❌ Fetch inserted client failed:", getErr);
              return res.status(500).json({ error: "Saved, but failed to fetch client" });
            }
            return res.json(newRow);
          });
        }
      );
    });
  } catch (e) {
    clear();
    console.error("❌ POST /api/clients crashed:", e);
    return res.status(500).json({ error: "Server error creating client" });
  }
});

/**
 * PATCH /api/clients/:id
 */
router.patch("/:id", (req, res) => {
  const clear = withTimeout(res, "PATCH /api/clients/:id");

  const id = req.params.id;

  try {
    const {
      name,
      phone,
      email,
      notes,
      language,
      office,
      case_type,
      AppointmentScheduledDate,
    } = req.body || {};

    const cleanName = (name || "").trim();
    const cleanPhone = canonicalPhone(phone);

    if (!cleanName) {
      clear();
      return res.status(400).json({ error: "Name is required" });
    }
    if (!cleanPhone || cleanPhone.length < 10) {
      clear();
      return res.status(400).json({ error: "Phone number is required (10 digits)" });
    }

    // prevent updating into someone else's phone
    db.get(
      "SELECT id FROM clients WHERE phone = ? AND id != ?",
      [cleanPhone, id],
      (dupeErr, dupeRow) => {
        if (dupeErr) {
          clear();
          console.error("❌ Duplicate check failed:", dupeErr);
          return res.status(500).json({ error: "Duplicate check failed" });
        }

        if (dupeRow) {
          clear();
          return res.status(409).json({ error: "That phone number already exists as a client." });
        }

        db.run(
          `
            UPDATE clients SET
              name = ?,
              phone = ?,
              email = ?,
              notes = ?,
              language = ?,
              office = ?,
              case_type = ?,
              appointment_datetime = ?
            WHERE id = ?
          `,
          [
            cleanName,
            cleanPhone,
            email || null,
            notes || null,
            language || "English",
            office || null,
            case_type || null,
            AppointmentScheduledDate || null,
            id,
          ],
          function (updErr) {
            if (updErr) {
              clear();
              console.error("❌ Client update failed:", updErr);
              return res.status(500).json({ error: "Failed to update client" });
            }

            db.get("SELECT * FROM clients WHERE id = ?", [id], (getErr, updated) => {
              clear();
              if (getErr) {
                console.error("❌ Fetch updated client failed:", getErr);
                return res.status(500).json({ error: "Updated, but failed to fetch client" });
              }
              return res.json(updated);
            });
          }
        );
      }
    );
  } catch (e) {
    clear();
    console.error("❌ PATCH /api/clients crashed:", e);
    return res.status(500).json({ error: "Server error updating client" });
  }
});

/**
 * PUT /api/clients/:id/status
 */
router.put("/:id/status", (req, res) => {
  const clear = withTimeout(res, "PUT /api/clients/:id/status");

  const id = req.params.id;
  const { status_id } = req.body || {};

  db.run(
    "UPDATE clients SET status_id = ? WHERE id = ?",
    [status_id || null, id],
    (err) => {
      clear();
      if (err) {
        console.error("❌ Status update failed:", err);
        return res.status(500).json({ success: false, error: "Status update failed" });
      }
      return res.json({ success: true });
    }
  );
});

/**
 * DELETE /api/clients/:id
 */
router.delete("/:id", (req, res) => {
  const clear = withTimeout(res, "DELETE /api/clients/:id");

  const id = req.params.id;

  db.run("DELETE FROM messages WHERE client_id = ?", [id], (err1) => {
    if (err1) console.error("❌ Delete messages failed:", err1);

    db.run("DELETE FROM clients WHERE id = ?", [id], (err2) => {
      clear();
      if (err2) {
        console.error("❌ Delete client failed:", err2);
        return res.status(500).json({ error: "Delete failed" });
      }
      return res.json({ success: true });
    });
  });
});

module.exports = router;
