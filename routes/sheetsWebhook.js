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
  return digits; // ✅ keep 10-digit phones
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

// normalize case type from CR/IMM/BK? column into your UI dropdown values
function normalizeMainCaseType(caseGroupRaw) {
  const v = String(caseGroupRaw || "").trim().toUpperCase();
  if (!v) return null;

  // handles "CR", "CRIMINAL", "CI - Criminal", etc
  if (v.includes("CR")) return "Criminal";
  if (v.includes("IMM")) return "Immigration";
  if (v.includes("BK") || v.includes("BANK")) return "Bankruptcy";

  return null;
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

    // Language headers vary across tabs
    const language = String(pick(row, "language", "SP/ENG?", "ENG/SP?", "SPENG?", "ENGSP?")).trim();

    // Main case type comes from CR/IMM/BK? (dropdown in your React form)
    const caseGroup = String(pick(row, "case_group", "CR/IMM/BK?", "CR/IMM/BK")).trim();
    const mainCaseType = normalizeMainCaseType(caseGroup);

    // Sub-case type is the detailed "CASE TYPE" text (your React "Sub Case Type" field)
    const case_subtype = String(pick(row, "case_subtype", "case_type", "CASE TYPE")).trim();

    // Appt Setter + I.C. headers vary (with/without dots)
    const appt_setter = cleanCode(pick(row, "appt_setter", "APPT SETTER", "APPT. SETTER"));
    const intake_coordinator = cleanCode(
      pick(row, "intake_coordinator", "ic", "I.C.", "I.C", "IC")
    );

    // Appt Date/Time headers vary (with/without dots)
    const appt_date = String(pick(row, "appt_date", "APPT DATE", "APPT. DATE")).trim();
    const appt_time = String(pick(row, "appt_time", "APPT TIME", "APPT. TIME")).trim();

    // keep old combined field too
    const appointment_datetime =
      buildAppointmentDatetime(appt_date, appt_time) ||
      String(pick(row, "appointment_at", "appointment_datetime")).trim() ||
      null;

    const notes = String(pick(row, "notes", "NOTES")).trim();

    if (!phone || phone.length !== 10) {
      return res.status(400).json({ ok: false, error: "Missing/invalid phone" });
    }

    const email = emailRaw || null;
    const finalOffice = office || null;
    const finalLanguage = language || null;

    // Keep backward compat: case_type column used in your clients list/details
    // We store the MAIN dropdown value there.
    const case_type = mainCaseType || null;

    // NOTE:
    // This SQL requires the optional columns to exist in clients table:
    // status_text, case_group, appt_setter, ic, appt_date, appt_time, case_subtype, intake_coordinator
    const sql = `
      INSERT INTO clients
        (name, phone, email, notes, language, office,
         case_type, case_subtype,
         appt_date, appt_time, appointment_datetime,
         status_id, status_text, case_group,
         appt_setter, intake_coordinator, ic)
      VALUES
        (?, ?, ?, ?, ?, ?,
         ?, ?,
         ?, ?, ?,
         ?, ?, ?,
         ?, ?, ?)
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
        intake_coordinator = excluded.intake_coordinator,
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

        case_type,
        case_subtype || null,

        appt_date || null,
        appt_time || null,
        appointment_datetime,

        status_id,
        statusText || null,
        caseGroup || null,

        appt_setter,
        intake_coordinator,
        // keep legacy column "ic" in sync too
        intake_coordinator,
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

            case_type,
            case_subtype,

            appt_date: appt_date || null,
            appt_time: appt_time || null,
            appointment_datetime,

            status_id,
            status_text: statusText || null,
            case_group: caseGroup || null,

            appt_setter,
            intake_coordinator,
            ic: intake_coordinator,

            notes: notes || null,
          });
        }

        return res.json({
          ok: true,
          status_id,
          updated: {
            case_type,
            case_subtype,
            appt_date,
            appt_time,
            appt_setter,
            intake_coordinator,
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
