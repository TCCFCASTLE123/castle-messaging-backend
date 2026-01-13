const express = require("express");
const router = express.Router();
const db = require("../db");

// Simple auth key so random people can’t hit this endpoint
function requireKey(req, res, next) {
  const key = req.header("x-webhook-key");
  if (!process.env.SHEETS_WEBHOOK_KEY || key !== process.env.SHEETS_WEBHOOK_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

// helper: normalize phone to digits
function normalizePhone(phone) {
  if (!phone) return "";
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

router.post("/update", requireKey, (req, res) => {
  const payload = req.body || {};
  const row = payload.row || {};
  // expected fields from Apps Script
  const name = (row.name || "").trim();
  const phone = normalizePhone(row.phone);
  const email = (row.email || "").trim();
  const office = (row.office || "").trim();
  const status = (row.status || "").trim();
  const caseGroup = (row.case_group || "").trim(); // CR/IMM/BK/PI
  const caseType = (row.case_type || "").trim();   // optional detail
  const language = (row.language || "").trim();
  const appointmentAt = (row.appointment_at || "").trim();
  const notes = (row.notes || "").trim();

  if (!phone && !name) {
    return res.status(400).json({ ok: false, error: "Missing phone/name" });
  }

  // Upsert by phone (preferred)
  const upsertSql = `
    INSERT INTO clients (name, phone, email, office, status, case_type, language, appointment_at, notes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(phone) DO UPDATE SET
      name=excluded.name,
      email=excluded.email,
      office=excluded.office,
      status=excluded.status,
      case_type=excluded.case_type,
      language=excluded.language,
      appointment_at=excluded.appointment_at,
      notes=excluded.notes,
      updated_at=datetime('now')
  `;

  // NOTE: This requires phone to be UNIQUE. If yours isn't yet, tell me and I’ll patch migration.
  db.run(
    upsertSql,
    [name, phone, email, office, status, caseGroup || caseType, language, appointmentAt, notes],
    function (err) {
      if (err) {
        console.error("❌ sheets webhook upsert error:", err.message);
        return res.status(500).json({ ok: false, error: err.message });
      }

      // emit socket event (if io is mounted on app)
      const io = req.app.get("io");
      if (io) {
        io.emit("client_updated", { phone, name, office, status, case_type: caseGroup || caseType, language, appointment_at: appointmentAt });
      }

      res.json({ ok: true });
    }
  );
});

module.exports = router;
