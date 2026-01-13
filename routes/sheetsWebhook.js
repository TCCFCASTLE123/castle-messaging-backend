// routes/sheetsWebhook.js

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

function canonicalPhone(input) {
  if (!input) return "";
  const digits = String(input).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

const ALLOWED_CODES = new Set([
  "CC","CLC","DT","GBC","ILD","JMP","JH","JWG","OXS","OAC","NVA","TRD","Walk-in"
]);

function cleanCode(v) {
  const s = (v || "").toString().trim();
  return ALLOWED_CODES.has(s) ? s : null;
}

function buildAppointmentDatetime(apptDate, apptTime) {
  const d = (apptDate || "").toString().trim();
  const t = (apptTime || "").toString().trim();
  if (!d && !t) return null;
  return `${d}${t ? " " + t : ""}`.trim();
}

function pick(row, ...keys) {
  for (const k of keys) {
    if (row && row[k] !== undefined && row[k] !== null) {
      const v = String(row[k]).trim();
      if (v !== "") return row[k];
    }
  }
  return "";
}

// lookup statuses.id by name (case-insensitive)
function getStatusIdByName(statusText) {
  return new Promise((resolve, reject) => {
    const s = (statusText || "").trim();
    if (!s) return resolve(null);

    db.get(
      "SELECT id FROM statuses WHERE LOWER(name) = LOWER(?)",
      [s],
      (err, row) => {
        if (err) return reject(err);
        resolve(row ? row.id : null);
      }
    );
  });
}

router.post("/update", requireKey, async (req, res) => {
  try {
    const payload = req.body || {};
    const row = payload.row || {};

    const name = String(pick(row, "name", "full_name", "FULL NAME")).trim();
    const phone = canonicalPhone(pick(row, "phone", "PHONE NUMBER"));
    const emailRaw = String(pick(row, "email", "EMAIL")).trim();
    const office = String(pick(row, "office", "OFFICE")).trim();

    const statusText = String(pick(row, "status", "STATUS")).trim(); // from sheet
    const status_id = await getStatusIdByName(statusText); // convert to id

    const caseGroup = String(pick(row, "case_group", "CR/IMM/BK?")).trim();
    const subCaseType = String(pick(row, "case_type", "CASE TYPE")).trim(); // “Sub Case Type” in UI
    const language = String(pick(row, "language", "SP/ENG?", "ENG/SP?")).trim();

    const apptSetter = cleanCode(pick(row, "appt_setter", "APPT. SETTER"));
    const ic = cleanCode(pick(row, "ic", "I.C."));

    const apptDate = String(pick(row, "appt_date", "APPT. DATE")).trim();
    const apptTime = String(pick(row, "appt_time", "APPT. TIME")).trim();
    const appointment_datetime =
      buildAppointmentDatetime(apptDate, apptTime) ||
      String(pick(row, "appointment_at")).trim() ||
      null;

    const notes = String(pick(row, "notes", "NOTES")).trim();

    if (!phone || phone.length !== 10) {
      return res.status(400).json({ ok: false, error: "Missing/invalid phone" });
    }

    const email = emailRaw || null;
    const finalOffice = office || null;
    const finalLanguage = language || null;

    const finalCaseType = (subCaseType || caseGroup || "").trim() || null;

    // NOTE: this assumes you have added these optional columns:
    // status_text, case_group, appt_setter, ic
    // If you didn't add them, remove them from SQL.
    const sql = `
      INSERT INTO clients
        (name, phone, email, notes, language, office, case_type, appointment_datetime,
         status_id, status_text, case_group, appt_setter, ic)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET
        name = excluded.name,
        email = excluded.email,
        notes = excluded.notes,
        language = excluded.language,
        office = excluded.office,
        case_type = excluded.case_type,
        appointment_datetime = excluded.appointment_datetime,
        status_id = excluded.status_id,
        status_text = excluded.status_text,
        case_group = excluded.case_group,
        appt_setter = excluded.appt_setter,
        ic = excluded.ic
    `;

    db.run(
      sql,
      [
        name || `Sheet ${phone}`,
        phone,
        email,
        notes || null,
        finalLanguage,
        finalOffice,
        finalCaseType,
        appointment_datetime,
        status_id,                 // ✅ what React dropdown needs
        statusText || null,        // optional display/debug
        caseGroup || null,
        apptSetter,
        ic,
      ],
      function (err) {
        if (err) {
          console.error("❌ sheets webhook upsert error:", err.message);
          return res.status(500).json({ ok: false, error: err.message });
        }

        if (req.io) {
          req.io.emit("client_updated", {
            phone,
            name: name || `Sheet ${phone}`,
            email,
            office: finalOffice,
            language: finalLanguage,
            case_type: finalCaseType,
            appointment_datetime,
            status_id,
            status_text: statusText || null,
            case_group: caseGroup || null,
            appt_setter: apptSetter,
            ic,
            notes: notes || null,
          });
        }

        return res.json({ ok: true, status_id, status_text: statusText || null });
      }
    );
  } catch (e) {
    console.error("❌ sheets webhook crashed:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

module.exports = router;
