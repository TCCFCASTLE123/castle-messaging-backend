// routes/clients.js — FINAL

const express = require("express");
const router = express.Router();
const db = require("../db");

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
      res.json(rows);
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

  if (!name || !phone) {
    return res.status(400).json({ error: "Name and phone required" });
  }

  db.run(
    `
    INSERT INTO clients
    (name, phone, email, notes, language, office, case_type, appointment_datetime)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      name,
      phone,
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
        return res.status(500).json({ error: "Failed to save client" });
      }

      db.get(
        "SELECT * FROM clients WHERE id = ?",
        [this.lastID],
        (_, row) => res.json(row)
      );
    }
  );
});

// UPDATE client
router.patch("/:id", (req, res) => {
  const { id } = req.params;

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
      req.body.name,
      req.body.phone,
      req.body.email,
      req.body.notes,
      req.body.language,
      req.body.office,
      req.body.case_type,
      req.body.AppointmentScheduledDate,
      id,
    ],
    function (err) {
      if (err) {
        console.error("Client update failed:", err);
        return res.status(500).json({ error: "Update failed" });
      }

      db.get("SELECT * FROM clients WHERE id = ?", [id], (_, row) =>
        res.json(row)
      );
    }
  );
});

// UPDATE status only
router.put("/:id/status", (req, res) => {
  const { status_id } = req.body;

  db.run(
    "UPDATE clients SET status_id = ? WHERE id = ?",
    [status_id, req.params.id],
    (err) => {
      if (err) {
        console.error("Status update failed:", err);
        return res.json({ success: false });
      }
      res.json({ success: true });
    }
  );
});

// DELETE client
router.delete("/:id", (req, res) => {
  db.run("DELETE FROM messages WHERE client_id = ?", [req.params.id]);
  db.run("DELETE FROM clients WHERE id = ?", [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: "Delete failed" });
    res.json({ success: true });
  });
});

module.exports = router;
