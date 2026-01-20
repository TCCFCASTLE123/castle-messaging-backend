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
  if (!s) return null;
  // If it matches your allowed set, keep it; otherwise still allow saving raw text
  return ALLOWED_CODES.has(s) ? s : s;
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

    const statusText = String(pick(row, "status", "STATUS")).trim();
    const status_id = await getStatusIdByName(statusText);

    const caseGroup = String(pick(row, "case_group", "CR/IMM/BK?")).trim();

    // ✅ main dropdown: Criminal/Immigration/Bankruptcy
    const caseTypeMain = String(pick(row, "case_type")).trim();

    // ✅ subtype: CI - Criminal Investigation, etc.
    const caseSubtype = String(pick(row, "case_subtype", "CASE TYPE", "SUB CASE TYPE")).trim();

    const language = String(pick(row, "language", "SP/ENG?", "ENG/SP?")).trim();

    const apptSetter = cleanCode(pick(row, "appt_setter", "APPT. SETTER"));

    // ✅ accept both names
    const icIncoming = pick(row, "ic", "intake_coordinator", "I.C.");
    const ic = cleanCode(icIncoming);
    const intake_coordinator = cleanCode(icIncoming);

    // ✅ should already be formatted by Apps Script
    const appt_date = String(pick(row, "appt_date", "APPT. DATE")).trim() || null;
    const appt_time = String(pick(row, "appt_time", "APPT. TIME")).trim() || null;

    const appointment_datetime =
      buildAppointmentDatetime(appt_date, appt_time) ||
      String(pick(row, "appointment_at")).trim() ||
      null;

    const notes = String(pick(row, "notes", "NOTES")).trim();

    // ✅ NEW: Assigned Attorney from Apps Script / sheet
    const attorney_assigned =
      String(
        pick(
          row,
          "attorney_assigned",
          "ATTORNEY_ASSIGNED",
          "ASSIGNED ATTORNEY",
          "ATTORNEY ASSIGNED"
        )
      ).trim() || null;

    if (!phone || phone.length !== 10) {
      return res.status(400).json({ ok: false, error: "Missing/invalid phone" });
    }

    const email = emailRaw || null;
    const finalOffice = office || null;
    const finalLanguage = language || null;

    // store main in case_type, detailed in case_subtype
    const finalCaseType = caseTypeMain || null;
    const finalCaseSubtype = caseSubtype || null;

    const sql = `
      INSERT INTO clients
        (
          name, phone, email, notes, language, office,
          case_type, case_subtype,
          appt_date, appt_time, appointment_datetime,
          status_id, status_text,
          case_group, appt_setter,
          ic, intake_coordinator,
          attorney_assigned
        )
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET
        name = excluded.name,
        email = excluded.email,
        notes = excluded.notes,
        language = excluded.language,
        office = excluded.office,

        case_type = excluded.case_type,
        case_subtype = excluded.case_subtype,

        appt_date = excluded.appt_date,
        appt_time = excluded.appt_time,
        appointment_datetime = excluded.appointment_datetime,

        status_id = excluded.status_id,
        status_text = excluded.status_text,

        case_group = excluded.case_group,
        appt_setter = excluded.appt_setter,

        ic = excluded.ic,
        intake_coordinator = excluded.intake_coordinator,

        -- ✅ do NOT wipe attorney if sheet sends blank/null
        attorney_assigned = COALESCE(excluded.attorney_assigned, clients.attorney_assigned)
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
        finalCaseSubtype,

        appt_date,
        appt_time,
        appointment_datetime,

        status_id,
        statusText || null,

        caseGroup || null,
        apptSetter,

        ic,
        intake_coordinator,

        attorney_assigned,
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
            case_subtype: finalCaseSubtype,

            appt_date,
            appt_time,
            appointment_datetime,

            status_id,
            status_text: statusText || null,

            case_group: caseGroup || null,
            appt_setter: apptSetter,

            ic,
            intake_coordinator,

            attorney_assigned, // ✅ NEW

            notes: notes || null,
          });
        }

        return res.json({
          ok: true,
          status_id,
          status_text: statusText || null,
          saved: {
            case_type: finalCaseType,
            case_subtype: finalCaseSubtype,
            appt_date,
            appt_time,
            ic,
            intake_coordinator,
            attorney_assigned, // ✅ NEW
          },
        });
      }
    );
  } catch (e) {
    console.error("❌ sheets webhook crashed:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

module.exports = router;
