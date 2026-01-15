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

// helper: treat null/"" as empty
function isEmpty(v) {
  return v === null || v === undefined || String(v).trim() === "";
}

// ✅ DAILY wins. CALL only fills blanks.
function mergeByPriority(existing, incoming, source) {
  if (!existing) return incoming;

  // If DAILY, overwrite freely
  if (String(source).toUpperCase() === "DAILY") return incoming;

  // If CALL, only fill blanks (don’t overwrite good DAILY values)
  if (String(source).toUpperCase() === "CALL") {
    const out = { ...existing };

    for (const k of Object.keys(incoming)) {
      const incVal = incoming[k];
      if (!isEmpty(incVal) && isEmpty(existing[k])) {
        out[k] = incVal;
      }
    }
    return out;
  }

  // default: overwrite
  return incoming;
}

router.post("/update", requireKey, async (req, res) => {
  try {
    const payload = req.body || {};
    const row = payload.row || {};
    const source = String(payload.source || "").toUpperCase(); // "DAILY" or "CALL"

    const name = String(pick(row, "name", "full_name", "FULL NAME")).trim();
    const phone = canonicalPhone(pick(row, "phone", "PHONE NUMBER"));

    if (!phone || phone.length !== 10) {
      return res.status(400).json({ ok: false, error: "Missing/invalid phone" });
    }

    const email = String(pick(row, "email", "EMAIL")).trim() || null;
    const office = String(pick(row, "office", "OFFICE")).trim() || null;

    const statusText = String(pick(row, "status", "STATUS")).trim();
    const status_id = await getStatusIdByName(statusText);

    const caseGroup = String(pick(row, "case_group", "CR/IMM/BK?")).trim() || null;

    // Your sheet "CASE TYPE" is usually the detailed value like "CI - Criminal Investigation"
    // We'll store that in case_subtype, and keep case_type as the broad group if you want.
    const caseSubtype = String(pick(row, "case_type", "CASE TYPE")).trim() || null;

    const language = String(pick(row, "language", "SP/ENG?", "ENG/SP?")).trim() || null;

    const appt_setter = cleanCode(pick(row, "appt_setter", "APPT. SETTER")) || null;
    const ic = cleanCode(pick(row, "ic", "I.C.")) || null;

    // ✅ IMPORTANT: store these in their own columns so React can show them
    const appt_date = String(pick(row, "appt_date", "APPT. DATE", "DATE")).trim() || null;
    const appt_time = String(pick(row, "appt_time", "APPT. TIME", "TIME")).trim() || null;

    const appointment_datetime =
      buildAppointmentDatetime(appt_date, appt_time) ||
      String(pick(row, "appointment_at")).trim() ||
      null;

    const notes = String(pick(row, "notes", "NOTES")).trim() || null;

    // Decide what you want "case_type" to be:
    // - broad group (Criminal/Immigration/Bankruptcy) from CR/IMM/BK?
    // - or the detailed thing from CASE TYPE
    // I recommend:
    //   case_type = broad group
    //   case_subtype = detailed case type
    const case_type = (caseGroup || "").trim() || null;

    // pull existing row so we can do DAILY-overrides/CALL-fill-blanks logic
    db.get("SELECT * FROM clients WHERE phone = ?", [phone], async (err, existing) => {
      if (err) {
        console.error("❌ sheets webhook select existing error:", err.message);
        return res.status(500).json({ ok: false, error: err.message });
      }

      const incoming = {
        name: name || (existing?.name || `Sheet ${phone}`),
        phone,
        email,
        notes,
        language,
        office,
        case_type,
        case_subtype: caseSubtype,
        appointment_datetime,
        status_id,
        status_text: statusText || null,
        case_group: caseGroup,
        appt_setter,
        ic,
        appt_date,
        appt_time,
      };

      const merged = mergeByPriority(existing, incoming, source);

      const sql = `
        INSERT INTO clients
          (name, phone, email, notes, language, office,
           case_type, case_subtype,
           appointment_datetime, status_id, status_text, case_group,
           appt_setter, ic, appt_date, appt_time)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(phone) DO UPDATE SET
          name = excluded.name,
          email = excluded.email,
          notes = excluded.notes,
          language = excluded.language,
          office = excluded.office,
          case_type = excluded.case_type,
          case_subtype = excluded.case_subtype,
          appointment_datetime = excluded.appointment_datetime,
          status_id = excluded.status_id,
          status_text = excluded.status_text,
          case_group = excluded.case_group,
          appt_setter = excluded.appt_setter,
          ic = excluded.ic,
          appt_date = excluded.appt_date,
          appt_time = excluded.appt_time
      `;

      db.run(
        sql,
        [
          merged.name,
          merged.phone,
          merged.email,
          merged.notes,
          merged.language,
          merged.office,
          merged.case_type,
          merged.case_subtype,
          merged.appointment_datetime,
          merged.status_id,
          merged.status_text,
          merged.case_group,
          merged.appt_setter,
          merged.ic,
          merged.appt_date,
          merged.appt_time,
        ],
        function (uErr) {
          if (uErr) {
            console.error("❌ sheets webhook upsert error:", uErr.message);
            return res.status(500).json({ ok: false, error: uErr.message });
          }

          if (req.io) {
            req.io.emit("client_updated", merged);
          }

          return res.json({ ok: true, source, status_id: merged.status_id });
        }
      );
    });
  } catch (e) {
    console.error("❌ sheets webhook crashed:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

module.exports = router;
