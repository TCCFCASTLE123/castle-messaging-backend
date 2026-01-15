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

function cleanText(v) {
  const s = (v ?? "").toString().trim();
  return s ? s : null;
}

function buildAppointmentDatetime(apptDate, apptTime) {
  const d = cleanText(apptDate);
  const t = cleanText(apptTime);
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

    const name = cleanText(pick(row, "name", "full_name", "FULL NAME"));
    const phone = canonicalPhone(pick(row, "phone", "PHONE NUMBER"));

    if (!phone || phone.length !== 10) {
      return res.status(400).json({ ok: false, error: "Missing/invalid phone" });
    }

    const email = cleanText(pick(row, "email", "EMAIL"));
    const office = cleanText(pick(row, "office", "OFFICE"));

    const statusText = cleanText(pick(row, "status", "STATUS"));
    const status_id = await getStatusIdByName(statusText || "");

    // From sheet:
    const caseGroup = cleanText(pick(row, "case_group", "CR/IMM/BK?"));       // "Criminal" / "Immigration" / etc (or CR/IMM/BK?)
    const sheetCaseType = cleanText(pick(row, "case_type", "CASE TYPE"));     // "CI - Criminal Investigation" etc

    const language = cleanText(pick(row, "language", "SP/ENG?", "ENG/SP?"));

    const apptSetter = cleanCode(pick(row, "appt_setter", "APPT. SETTER"));
    const ic = cleanCode(pick(row, "ic", "I.C."));

    const apptDate = cleanText(pick(row, "appt_date", "APPT. DATE"));
    const apptTime = cleanText(pick(row, "appt_time", "APPT. TIME"));

    const appointment_datetime =
      buildAppointmentDatetime(apptDate, apptTime) ||
      cleanText(pick(row, "appointment_at")) ||
      null;

    const notes = cleanText(pick(row, "notes", "NOTES"));

    // ✅ FIX: case_type should be broad (Criminal/Immigration/Bankruptcy)
    // ✅ FIX: case_subtype should be the detailed sheet case type
    const case_type = (caseGroup || "").trim() || null;
    const case_subtype = (sheetCaseType || "").trim() || null;

    const sql = `
      INSERT INTO clients
        (
          name, phone, email, notes, language, office,
          case_type, case_subtype,
          appt_setter, ic,
          appt_date, appt_time,
          appointment_datetime,
          status_id, status_text, case_group
        )
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET
        name = COALESCE(excluded.name, clients.name),
        email = COALESCE(excluded.email, clients.email),
        notes = COALESCE(excluded.notes, clients.notes),
        language = COALESCE(excluded.language, clients.language),
        office = COALESCE(excluded.office, clients.office),

        case_type = COALESCE(excluded.case_type, clients.case_type),
        case_subtype = COALESCE(excluded.case_subtype, clients.case_subtype),

        appt_setter = COALESCE(excluded.appt_setter, clients.appt_setter),
        ic = COALESCE(excluded.ic, clients.ic),

        appt_date = COALESCE(excluded.appt_date, clients.appt_date),
        appt_time = COALESCE(excluded.appt_time, clients.appt_time),

        appointment_datetime = COALESCE(excluded.appointment_datetime, clients.appointment_datetime),

        status_id = COALESCE(excluded.status_id, clients.status_id),
        status_text = COALESCE(excluded.status_text, clients.status_text),
        case_group = COALESCE(excluded.case_group, clients.case_group)
    `;

    db.run(
      sql,
      [
        name || `Sheet ${phone}`,
        phone,
        email,
        notes,
        language,
        office,
        case_type,
        case_subtype,
        apptSetter,
        ic,
        apptDate,
        apptTime,
        appointment_datetime,
        status_id,
        statusText,
        caseGroup,
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
            office,
            language,
            case_type,
            case_subtype,
            appt_setter: apptSetter,
            ic,
            appt_date: apptDate,
            appt_time: apptTime,
            appointment_datetime,
            status_id,
            status_text: statusText,
            case_group: caseGroup,
            notes,
          });
        }

        return res.json({ ok: true, status_id, phone });
      }
    );
  } catch (e) {
    console.error("❌ sheets webhook crashed:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

module.exports = router;
