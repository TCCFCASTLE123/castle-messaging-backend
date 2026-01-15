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

function pick(row, ...keys) {
  for (const k of keys) {
    if (row && row[k] !== undefined && row[k] !== null) {
      const v = String(row[k]).trim();
      if (v !== "") return row[k];
    }
  }
  return "";
}

function buildAppointmentDatetime(apptDate, apptTime) {
  const d = (apptDate || "").toString().trim();
  const t = (apptTime || "").toString().trim();
  if (!d && !t) return null;
  return `${d}${t ? " " + t : ""}`.trim();
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

    const statusText = String(pick(row, "status", "STATUS")).trim();
    const status_id = await getStatusIdByName(statusText);

    const language = String(pick(row, "language", "SP/ENG?", "ENG/SP?")).trim();

    // ✅ main + sub case types (your new script sends these)
    const case_type = String(pick(row, "case_type")).trim();          // Criminal / Immigration / Bankruptcy
    const case_subtype = String(pick(row, "case_subtype", "CASE TYPE", "SUB CASE TYPE")).trim(); // CI - ..., IMM - ...

    // ✅ IC + appt setter
    const appt_setter = cleanCode(pick(row, "appt_setter", "APPT. SETTER"));
    const ic = cleanCode(pick(row, "ic", "intake_coordinator", "I.C.", "INTAKE COORDINATOR"));

    // ✅ store split appt date/time too
    const appt_date = String(pick(row, "appt_date", "APPT. DATE")).trim() || null;
    const appt_time = String(pick(row, "appt_time", "APPT. TIME")).trim() || null;

    // ✅ combined field for your card
    const appointment_datetime =
      buildAppointmentDatetime(appt_date, appt_time) ||
      String(pick(row, "appointment_at")).trim() ||
      null;

    const notes = String(pick(row, "notes", "NOTES")).trim();

    if (!phone || phone.length !== 10) {
      return res.status(400).json({ ok: false, error: "Missing/invalid phone" });
    }

    const email = emailRaw || null;
    const finalOffice = office || null;
    const finalLanguage = language || null;

    // Optional extra columns you already added
    const case_group = String(pick(row, "case_group", "CR/IMM/BK?")).trim() || null;

    const sql = `
      INSERT INTO clients
        (
          name, phone, email, notes, language, office,
          case_type, case_subtype,
          appointment_datetime,
          appt_date, appt_time,
          status_id, status_text,
          case_group,
          appt_setter,
          ic,
          intake_coordinator
        )
      VALUES
        (?, ?, ?, ?, ?, ?,
         ?, ?,
         ?,
         ?, ?,
         ?, ?,
         ?,
         ?,
         ?,
         ?)
      ON CONFLICT(phone) DO UPDATE SET
        name = excluded.name,
        email = excluded.email,
        notes = excluded.notes,
        language = excluded.language,
        office = excluded.office,

        case_type = excluded.case_type,
        case_subtype = excluded.case_subtype,

        appointment_datetime = excluded.appointment_datetime,
        appt_date = excluded.appt_date,
        appt_time = excluded.appt_time,

        status_id = excluded.status_id,
        status_text = excluded.status_text,

        case_group = excluded.case_group,
        appt_setter = excluded.appt_setter,
        ic = excluded.ic,
        intake_coordinator = excluded.intake_coordinator
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

        case_type || null,
        case_subtype || null,

        appointment_datetime,

        appt_date,
        appt_time,

        status_id,
        statusText || null,

        case_group,
        appt_setter,
        ic,
        ic, // intake_coordinator mirrors ic so your modal fills
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

            case_type: case_type || null,
            case_subtype: case_subtype || null,

            appointment_datetime,
            appt_date,
            appt_time,

            status_id,
            status_text: statusText || null,
            case_group,

            appt_setter,
            ic,
            intake_coordinator: ic,

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
