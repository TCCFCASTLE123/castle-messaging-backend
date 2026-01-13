const express = require("express");
const router = express.Router();
const db = require("../db");

function requireKey(req, res, next) {
  const key = req.header("x-webhook-key");
  if (!process.env.SHEETS_WEBHOOK_KEY || key !== process.env.SHEETS_WEBHOOK_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

function normalizePhone(phone) {
  if (!phone) return "";
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

router.post("/update", requireKey, (req, res) => {
  const payload = req.body || {};
  const row = payload.row || {};

  // source should be "CALL" or "DAILY"
  const source = String(payload.source || row.source || "").trim().toUpperCase();

  const name = (row.name || "").trim();
  const phone = normalizePhone(row.phone);
  const email = (row.email || "").trim();
  const office = (row.office || "").trim();

  // status meaning depends on source
  const status = (row.status || "").trim();

  const caseGroup = (row.case_group || "").trim(); // CR/IMM/BK?/PI
  const caseType = (row.case_type || "").trim();
  const language = (row.language || "").trim();
  const appointmentAt = (row.appointment_at || "").trim();
  const notes = (row.notes || "").trim();

  if (!phone) {
    return res.status(400).json({ ok: false, error: "Missing/invalid phone" });
  }

  const finalCase = caseGroup || caseType;

  // We always update shared fields, but DAILY is the most-updated source in your world.
  // So: DAILY should overwrite; CALL can fill blanks but not overwrite if you prefer.
  // You told me: DAILY most updated — so we overwrite on DAILY, and for CALL we also overwrite (fine),
  // but the "current status" in UI should prefer daily_status if present.
  const callStatus = source === "CALL" ? status : null;
  const dailyStatus = source === "DAILY" ? status : null;

  const sql = `
    INSERT INTO clients
      (name, phone, email, office, language, case_type, appointment_at, notes, call_status, daily_status, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(phone) DO UPDATE SET
      name = excluded.name,
      email = excluded.email,
      office = excluded.office,
      language = excluded.language,
      case_type = excluded.case_type,
      appointment_at = excluded.appointment_at,
      notes = excluded.notes,

      call_status = COALESCE(excluded.call_status, clients.call_status),
      daily_status = COALESCE(excluded.daily_status, clients.daily_status),

      updated_at = datetime('now')
  `;

  db.run(
    sql,
    [name, phone, email, office, language, finalCase, appointmentAt, notes, callStatus, dailyStatus],
    function (err) {
      if (err) {
        console.error("❌ sheets webhook upsert error:", err.message);
        return res.status(500).json({ ok: false, error: err.message });
      }

      // Emit live update
      if (req.io) {
        req.io.emit("client_updated", {
          source,
          phone,
          name,
          email,
          office,
          language,
          case_type: finalCase,
          appointment_at: appointmentAt,
          call_status: callStatus,
          daily_status: dailyStatus,
        });
      }

      return res.json({ ok: true });
    }
  );
});

module.exports = router;
