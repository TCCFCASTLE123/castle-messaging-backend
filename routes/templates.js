const express = require('express');
const router = express.Router();
const db = require('../db');

// === Get all templates ===
router.get('/', (req, res) => {
  db.all('SELECT * FROM templates ORDER BY id DESC', (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to load templates' });
    res.json(rows);
  });
});

// === Add new template ===
router.post("/", (req, res) => {
  const { status, office, case_type, appointment_type, language, delay_hours, template, active } = req.body;
  if (!template) return res.status(400).json({ error: "Template message required" });

  db.run(
    `INSERT INTO templates (status, office, case_type, appointment_type, language, delay_hours, template, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      status || "",
      office || "",
      case_type || "",
      appointment_type || "",
      language || "",
      Number(delay_hours || 0),
      template,
      active ? 1 : 0,
    ],
    function (err) {
      if (err) {
        console.error("❌ TEMPLATE INSERT ERROR:", err);
        return res.status(500).json({ error: err.message }); // 👈 IMPORTANT
      }
      res.json({ id: this.lastID, ...req.body });
    }
  );
});

// === Update template ===
router.put('/:id', (req, res) => {
  const { status, office, case_type, appointment_type, language, delay_hours, template, active } = req.body;
  if (!template) return res.status(400).json({ error: "Template message required" });

  db.run(
    `UPDATE templates SET
      status = ?,
      office = ?,
      case_type = ?,
      appointment_type = ?,
      language = ?,
      delay_hours = ?,
      template = ?,
      active = ?
     WHERE id = ?`,
    [
      status || "",
      office || "",
      case_type || "",
      appointment_type || "",
      language || "",
      delay_hours || 0,
      template,
      active ? 1 : 0,
      req.params.id
    ],
    function (err) {
      if (err) return res.status(500).json({ error: "Failed to update template" });
      res.json({ success: true });
    }
  );
});

// === Delete template ===
router.delete('/:id', (req, res) => {
  db.run('DELETE FROM templates WHERE id = ?', [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: "Failed to delete template" });
    res.json({ success: true });
  });
});
// === Get a single template by id ===
router.get('/:id', (req, res) => {
  db.get('SELECT * FROM templates WHERE id = ?', [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: "Failed to load template" });
    if (!row) return res.status(404).json({ error: "Template not found" });
    res.json(row);
  });
});

module.exports = router;

