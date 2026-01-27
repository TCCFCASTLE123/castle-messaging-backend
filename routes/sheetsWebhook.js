// routes/sheetsWebhook.js

const express = require("express");
const router = express.Router();
const db = require("../db");
const { enqueueTemplatesForClient } = require("../lib/enqueueTemplates");

/* ===================== AUTH ===================== */

function requireKey(req, res, next) {
  const key = req.header("x-webhook-key");
  if (!process.env.SHEETS_WEBHOOK_KEY || key !== process.env.SHEETS_WEBHOOK_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

/* ===================== HELPERS ===================== */

function canonicalPhone(input) {
  if (!input) return "";
  const digits = String(input).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
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

const ALLOWED_CODES = new Set([
  "CC","CLC","DT","GBC","ILD","JMP","JH","JWG","OXS","OAC","NVA","TRD","Walk-in"
]);

function cleanCode(v) {
  const s = (v || "").toString().trim();
  if (!s) return null;
  return ALLOWED_CODES.has(s) ? s : s;
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

/* ===================== ROUTE ===================== */

router.post("/update", requireKey, async (req, res) => {
  try {
    const payload = req.body || {};
    const row = payload.row || {};

    const name = String(pick(row, "name", "full_name", "FULL NAME")).trim();
    const phone = canonicalPhone(pick(row, "phone", "PHONE NUMBER"));
    if (!phone || phone.length !== 10) {
      return res.status(400).json({ ok: false, error: "Missing/invalid phone" });
    }

    const email = String(pick(row, "email", "EMAIL")).trim() || null;
    const office = String(pick(row, "office", "OFFICE")).trim() || null;
    const language = String(pick(row, "language", "SP/ENG?", "ENG/SP?")).trim() || null;

    const statusText = String(pick(row, "status", "STATUS")).trim();
    const status_id = await getStatusIdByName(statusText);

    const case_type = String(pick(row, "case_type")).trim() || null;
    const case_subtype = String(
      pick(row, "case_subtype", "CASE TYPE", "SUB CASE TYPE")
    ).trim() || null;

    const apptSetter = cleanCode(pick(row, "appt_setter", "APPT. SETTER"));

    const icIncoming = pick(row, "ic", "intake_coordinator", "I.C.");
    const ic = cleanCode(icIncoming);
    const intake_coordinator = cleanCode(icIncoming);

    const appt_date = String(pick(row, "appt_date", "APPT. DATE")).trim() || null;
    const appt_time = String(pick(row, "appt_time", "APPT. TIME")).trim() || null;

    const appointment_datetime =
      buildAppointmentDatetime(appt_date, appt_time) ||
      String(pick(row, "appointment_at")).trim() ||
      null;

    const notes = String(pick(row, "notes", "NOTES")).trim() || null;

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

    /* ---------- LOAD OLD STATUS BEFORE UPSERT ---------- */

    const oldStatusId = await new Promise((resolve) => {
      db.get(
        "SELECT status_id FROM clients WHERE phone = ?",
        [phone],
        (err, row) => resolve(row ? row.status_id : null)
      );
    });

    /* ---------- UPSERT CLIENT ---------- */

    const sql = `
      INSERT INTO clients
      (
        name, phone, email, notes, language, office,
        case_type, case_subtype,
        appt_date, appt_time, appointment_datetime,
        status_id, status_text,
        appt_setter, ic, intake_coordinator, attorney_assigned
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

        appt_setter = excluded.appt_setter,
        ic = excluded.ic,
        intake_coordinator = excluded.intake_coordinator,

        attorney_assigned = COALESCE(excluded.attorney_assigned, clients.attorney_assigned)
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

        appt_date,
        appt_time,
        appointment_datetime,

        status_id,
        statusText || null,

        apptSetter,
        ic,
        intake_coordinator,
        attorney_assigned,
      ],
      async (err) => {
        if (err) {
          console.error("❌ sheets webhook upsert error:", err.message);
          return res.status(500).json({ ok: false, error: err.message });
        }

        /* ---------- 🔥 AUTOMATION TRIGGER ---------- */

        if (oldStatusId !== status_id) {
          db.get(
            `
            SELECT c.*, s.name AS status
            FROM clients c
            LEFT JOIN statuses s ON s.id = c.status_id
            WHERE c.phone = ?
            `,
            [phone],
            async (err2, updatedClient) => {
              if (!err2 && updatedClient && updatedClient.status) {
                try {
                  await enqueueTemplatesForClient(updatedClient);
                } catch (e) {
                  console.error("❌ Sheet-triggered enqueue failed:", e.message);
                }
              }
            }
          );
        }

        return res.json({ ok: true, status_id, status_text: statusText });
      }
    );
  } catch (e) {
    console.error("❌ sheets webhook crashed:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

module.exports = router;
