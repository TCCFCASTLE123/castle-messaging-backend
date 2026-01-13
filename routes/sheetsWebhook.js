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

// MUST match routes/clients.js storage (10 digits)
function canonicalPhone(input) {
  if (!input) return "";
  const digits = String(input).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

// dropdown codes for APPT SETTER + I.C.
const ALLOWED_CODES = new Set([
  "CC",
  "CLC",
  "DT",
  "GBC",
  "ILD",
  "JMP",
  "JH",
  "JWG",
  "OXS",
  "OAC",
  "NVA",
  "TRD",
  "Walk-in",
]);

function cleanCode(v) {
  const s = (v || "").toString().trim();
  return ALLOWED_CODES.has(s) ? s : null;
}

function buildAppointmentDatetime(apptDate, apptTime) {
  const d = (apptDate || "").toString().trim();
  const t = (apptTime || "").toString().trim();
  if (!d && !t) return null;
  return `${d}${t ? " " + t : ""}`.trim(); // store as readable string (stable)
}

// helper to read either your Apps Script keys or raw sheet header keys
function pick(row, ...keys) {
  for (const k of keys) {
    if (row && row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== "") {
      return row[k];
    }
  }
  return "";
}

/**
 * POST /api/sheets/update
 * Expected payload shape:
 * { row: { ...fields... }, source?: "DAILY"|"CALL" }
 *
 * We map sheet columns to DB:
 * - FULL NAME -> name
 * - PHONE NUMBER -> phone (canonical)
 * - EMAIL -> email
 * - OFFICE -> office
 * - SP/ENG? -> language
 * - CR/IMM/BK? -> case_group
 * - "Sub Case Type" (your UI label) -> case_type (from CASE TYPE column)
 * - APPT DATE + APPT TIME -> appointment_datetime
 * - STATUS -> status_text
 * - APPT. SETTER -> appt_setter
 * - I.C. -> ic
 * - NOTES -> notes
 */
router.post("/update", requireKey, (req, res) => {
  try {
    const payload = req.body || {};
    const row = payload.row || {};

    const name = String(pick(row, "name", "full_name", "FULL NAME")).trim();
    const phone = canonicalPhone(pick(row, "phone", "PHONE NUMBER"));
    const emailRaw = String(pick(row, "email", "EMAIL")).trim();
    const office = String(pick(row, "office", "OFFICE")).trim();

    const statusText = String(pick(row, "status", "STATUS")).trim();
    const caseGroup = String(pick(row, "case_group", "CR/IMM/BK?")).trim();

    // "Sub Case Type" is just your front-facing label.
    // We store it in DB as case_type using the sheet "CASE TYPE" column.
    const subCaseType = String(pick(row, "case_type", "CASE TYPE")).trim();

    const language = String(pick(row, "language", "SP/ENG?")).trim();

    const apptSetter = cleanCode(pick(row, "appt_setter", "APPT. SETTER"));
    const ic = cleanCode(pick(row, "ic", "I.C."));

    const apptDate = String(pick(row, "appt_date", "APPT. DATE")).trim();
    const apptTime = String(pick(row, "appt_time", "APPT. TIME")).trim();
    const appointment_datetime = buildAppointmentDatetime(apptDate, apptTime);

    const notes = String(pick(row, "notes", "NOTES")).trim();

    if (!phone || phone.length !== 10) {
      return res.status(400).json({ ok: false, error: "Missing/invalid phone" });
    }

    const email = emailRaw || null;
    const finalOffice = office || null;
    const finalLanguage = language || null;
    const finalStatus = statusText || null;
    const finalCaseGroup = caseGroup || null;

    // prefer Sub Case Type; if blank, fallback to group
    const finalCaseType = (subCaseType || caseGroup || "").trim() || null;

    const sql = `
      INSERT INTO clients
        (name, phone, email, notes, language, office, case_type, appointment_datetime,
         status_text, case_group, appt_setter, ic)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET
        name = excluded.name,
        email = excluded.email,
        notes = excluded.notes,
        language = excluded.language,
        office = excluded.office,
        case_type = excluded.case_type,
        appointment_datetime = excluded.appointment_datetime,
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
        finalStatus,
        finalCaseGroup,
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
            case_type: finalCaseType, // you can label this “Sub Case Type” in React
            case_group: finalCaseGroup,
            status_text: finalStatus,
            appointment_datetime,
            appt_setter: apptSetter,
            ic,
            notes: notes || null,
          });
        }

        return res.json({ ok: true });
      }
    );
  } catch (e) {
    console.error("❌ sheets webhook crashed:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

module.exports = router;
