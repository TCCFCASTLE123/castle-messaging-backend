// routes/clients.js — FINAL (robust client create/edit + clean errors)

const express = require("express");
const router = express.Router();
const db = require("../db");

function canonicalPhone(input) {
  if (!input) return "";
  const digits = String(input).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10) return digits;
  return digits;
}

// GET all clients
router.get("/", (req, res) => {
  db.all(
    `
    SELECT c.*, s.name AS status_name
    FROM clients c
    LEFT JOIN statuses s ON c.status_id = s.id
    ORDER BY c.created_at DESC
    `,
    (err, rows) => {
      if (err) {
        console.error("Clients fetch failed:", err);
        return res.status(500).json([]);
      }
      res.json(rows || []);
    }
  );
});

// CREATE client
router.post("/", (req, res) => {
  const {
    name,
    phone,
    email,
    notes,
    language,
    office,
    case_type,
    AppointmentScheduledDate,
  } = req.body;

  const phoneCanon = canonicalPhone(phone);

  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Name is required." });
  }
  if (!phoneCanon || phoneCanon.length < 10) {
    return res.status(400).json({ error: "Phone number is required (10 digits)." });
  }

  db.run(
    `
    INSERT INTO clients
    (name, phone, email, notes, language, office, case_type, appointment_datetime)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      name.trim(),
      phoneCanon,
      email || null,
      notes || null,
      language || "English",
      office || null,
      case_type || null,
      AppointmentScheduledDate || null,
    ],
    function (err) {
      if (err) {
        console.error("Client insert failed:", err);

        // Duplicate phone
        if (String(err.message || "").includes("UNIQUE constraint failed: clients.phone")) {
          return res.status(409).json({ error: "That phone number already exists as a client." });
        }

        return res.status(500).json({ error: "Failed to save client." });
      }

      db.get("SELECT * FROM clients WHERE id = ?", [this.lastID], (_, row) => {
        res.json(row);
      });
    }
  );
});

// UPDATE client
router.patch("/:id", (req, res) => {
  const { id } = req.params;

  const phoneCanon = canonicalPhone(req.body.phone);

  if (!req.body.name || !req.body.name.trim()) {
    return res.status(400).json({ error: "Name is required." });
  }
  if (!phoneCanon || phoneCanon.length < 10) {
    return res.status(400).json({ error: "Phone number is required (10 digits)." });
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
      req.body.name.trim(),
      phoneCanon,
      req.body.email || null,
      req.body.notes || null,
      req.body.language || "English",
      req.body.office || null,
      req.body.case_type || null,
      req.body.AppointmentScheduledDate || null,
      id,
    ],
    function (err) {
      if (err) {
        console.error("Client update failed:", err);

        if (String(err.message || "").includes("UNIQUE constraint failed: clients.phone")) {
          return res.status(409).json({ error: "That phone number already exists as a client." });
        }

        return res.status(500).json({ error: "Update failed." });
      }

      db.get("SELECT * FROM clients WHERE id = ?", [id], (_, row) => res.json(row));
    }
  );
});

// UPDATE status only
router.put("/:id/status", (req, res) => {
  const { status_id } = req.body;

  db.run(
    "UPDATE clients SET status_id = ? WHERE id = ?",
    [status_id || null, req.params.id],
    (err) => {
      if (err) {
        console.error("Status update failed:", err);
        return res.json({ success: false });
      }
      res.json({ success: true });
    }
  );
});

// DELETE client (and messages)
router.delete("/:id", (req, res) => {
  db.run("DELETE FROM messages WHERE client_id = ?", [req.params.id], (err1) => {
    if (err1) console.error("Delete messages failed:", err1);

    db.run("DELETE FROM clients WHERE id = ?", [req.params.id], (err2) => {
      if (err2) {
        console.error("Delete client failed:", err2);
        return res.status(500).json({ error: "Delete failed" });
      }
      res.json({ success: true });
    });
  });
});

module.exports = router;
