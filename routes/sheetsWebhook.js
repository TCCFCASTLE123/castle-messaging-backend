const express = require("express");
const router = express.Router();
const db = require("../db");

// Auth key so only your Apps Script can hit this
function requireKey(req, res, next) {
  const key = req.header("x-webhook-key");
  if (!process.env.SHEETS_WEBHOOK_KEY || key !== process.env.SHEETS_WEBHOOK_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

// Normalize phone to digits (10-digit)
function normalizePhone(phone) {
  if (!phone) return "";
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

router.post("/update", requireKey, (req, res) => {
  const payload = req.body || {};
  const row = payload.row || {};

  const name = (row.name || "").trim();
  const phone = normalizePhone(row.phone);
  const email = (row.email || "").trim();
  const office = (row.office || "").trim();
  const status = (row.status || "").trim();
  const caseGroup = (row.case_group || "").trim(); // CR/IMM/BK?/PI
  const caseType = (row.case_type || "").trim();   // optional
  const language = (row.language || "").trim();
  const appointmentAt = (row.appointment_at || "").trim();
  const notes = (row.notes || "").trim();

  // Require phone for upsert key
  if (!phone) {
    return res.status(400).json({ ok: false, error: "Missing/invalid phone" });
  }

  // Upsert by phone (requires UNIQUE index on clients(phone))
  const sql = `
    INSERT INTO clients
      (name, phone, email, office, status, case_type, language, appointment_at, notes, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(phone) DO UPDATE SET
      name = excluded.name,
      email = excluded.email,
      office = excluded.office,
      status = excluded.status,
      case_type = excluded.case_type,
      language = excluded.language,
      appointment_at = excluded.appointment_at,
      notes = excluded.notes,
      updated_at = datetime('now')
  `;

  const finalCase = caseGroup || caseType;

  db.run(
    sql,
    [name, phone, email, office, status, finalCase, language, appointmentAt, notes],
    function (err) {
      if (err) {
        console.error("❌ sheets webhook upsert error:", err.message);
        return res.status(500).json({ ok: false, error: err.message });
      }

      // Emit to React
      if (req.io) {
        req.io.emit("client_updated", {
          phone,
          name,
          email,
          office,
          status,
          case_type: finalCase,
          language,
          appointment_at: appointmentAt,
        });
      }

      return res.json({ ok: true });
    }
  );
});

module.exports = router;
