// routes/clients.js — CLEAN + SAFE PATCH (does not wipe with blank strings)

const express = require("express");
const router = express.Router();
const db = require("../db");
const { enqueueTemplatesForClient } = require("../lib/enqueueTemplates");

function canonicalPhone(input) {
  if (!input) return "";
  const digits = String(input).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

// Treat "" as "not provided" for PATCH so we don't wipe existing values.
function cleanPatchValue(v) {
  if (v === undefined) return undefined; // not provided
  if (v === "") return undefined; // ignore blank strings
  return v;
}

// Optional: prevents "pending forever" if sqlite is locked
function withTimeout(res, label, ms = 12000) {
  const t = setTimeout(() => {
    console.error(`❌ ${label} timed out after ${ms}ms`);
    if (!res.headersSent) res.status(504).json({ error: "Request timed out" });
  }, ms);
  return () => clearTimeout(t);
}

/**
 * GET /api/clients
 */
router.get("/", (req, res) => {
  const clear = withTimeout(res, "GET /api/clients");

  db.all(
    `
      SELECT c.*, s.name AS status_name
      FROM clients c
      LEFT JOIN statuses s ON c.status_id = s.id
      ORDER BY
        CASE WHEN c.last_message_at IS NULL OR c.last_message_at = '' THEN 1 ELSE 0 END,
        datetime(c.last_message_at) DESC,
        c.id DESC
    `,
    [],
    (err, rows) => {
      clear();
      if (err) {
        console.error("❌ GET clients failed:", err);
        return res.status(500).json({ error: "Failed to load clients" });
      }
      return res.json(rows || []);
    }
  );
});

/**
 * POST /api/clients
 */
router.post("/", (req, res) => {
  const clear = withTimeout(res, "POST /api/clients");

  try {
    const {
      name,
      phone,
      email,
      notes,
      language,
      office,
      case_type,
      case_subtype,
      appt_setter,
      ic,
      attorney_assigned, // ✅ NEW
      intake_coordinator,
      appt_date,
      appt_time,
    } = req.body || {};

    const cleanName = (name || "").trim();
    const cleanPhone = canonicalPhone(phone);

    if (!cleanName) {
      clear();
      return res.status(400).json({ error: "Name is required" });
    }
    if (!cleanPhone || cleanPhone.length !== 10) {
      clear();
      return res.status(400).json({ error: "Phone number is required (10 digits)" });
    }

    db.get("SELECT id FROM clients WHERE phone = ?", [cleanPhone], (err, row) => {
      if (err) {
        clear();
        console.error(err);
        return res.status(500).json({ error: "Lookup failed" });
      }
      if (row) {
        clear();
        return res.status(409).json({ error: "That phone number already exists." });
      }

      db.run(
        `
          INSERT INTO clients
          (
            name, phone, email, notes, language, office,
            case_type, case_subtype,
            appt_setter, ic, attorney_assigned, intake_coordinator,
            appt_date, appt_time
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          cleanName,
          cleanPhone,
          email || null,
          notes || null,
          language || "English",
          office || null,
          case_type || null,
          case_subtype || null,
          appt_setter || null,
          ic || null,
          attorney_assigned || null, // ✅ NEW
          intake_coordinator || null,
          appt_date || null,
          appt_time || null,
        ],
        function (insertErr) {
          if (insertErr) {
            clear();
            console.error(insertErr);
            return res.status(500).json({ error: "Insert failed" });
          }

          db.get("SELECT * FROM clients WHERE id = ?", [this.lastID], (gErr, row2) => {
            clear();
            if (gErr) {
              console.error(gErr);
              return res.status(500).json({ error: "Fetch failed" });
            }
            return res.json(row2);
          });
        }
      );
    });
  } catch (e) {
    clear();
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * PATCH /api/clients/:id
 * ✅ does NOT overwrite existing values with "" (blank strings)
 */
router.patch("/:id", (req, res) => {
  const clear = withTimeout(res, "PATCH /api/clients/:id");
  const id = req.params.id;

  try {
    db.get("SELECT * FROM clients WHERE id = ?", [id], (err, existing) => {
      if (err) {
        clear();
        console.error(err);
        return res.status(500).json({ error: "Load failed" });
      }
      if (!existing) {
        clear();
        return res.status(404).json({ error: "Client not found" });
      }

      const body = req.body || {};

      const nameVal = cleanPatchValue(body.name);
      const phoneVal = cleanPatchValue(body.phone);

      const merged = {
        name: nameVal !== undefined ? String(nameVal).trim() : existing.name || "",
        phone: phoneVal !== undefined ? canonicalPhone(phoneVal) : existing.phone || "",

        email: cleanPatchValue(body.email) !== undefined ? body.email : existing.email,
        notes: cleanPatchValue(body.notes) !== undefined ? body.notes : existing.notes,
        language: cleanPatchValue(body.language) !== undefined ? body.language : existing.language,
        office: cleanPatchValue(body.office) !== undefined ? body.office : existing.office,

        case_type: cleanPatchValue(body.case_type) !== undefined ? body.case_type : existing.case_type,
        case_subtype: cleanPatchValue(body.case_subtype) !== undefined ? body.case_subtype : existing.case_subtype,

        appt_setter: cleanPatchValue(body.appt_setter) !== undefined ? body.appt_setter : existing.appt_setter,
        ic: cleanPatchValue(body.ic) !== undefined ? body.ic : existing.ic,

        // ✅ NEW
        attorney_assigned:
          cleanPatchValue(body.attorney_assigned) !== undefined
            ? body.attorney_assigned
            : existing.attorney_assigned,

        intake_coordinator:
          cleanPatchValue(body.intake_coordinator) !== undefined
            ? body.intake_coordinator
            : existing.intake_coordinator,

        appt_date: cleanPatchValue(body.appt_date) !== undefined ? body.appt_date : existing.appt_date,
        appt_time: cleanPatchValue(body.appt_time) !== undefined ? body.appt_time : existing.appt_time,
      };

      if (!merged.name || !merged.phone) {
        clear();
        return res.status(400).json({ error: "Name and phone required" });
      }
      if (merged.phone.length !== 10) {
        clear();
        return res.status(400).json({ error: "Phone must be 10 digits" });
      }

      db.get("SELECT id FROM clients WHERE phone = ? AND id != ?", [merged.phone, id], (dErr, dup) => {
        if (dErr) {
          clear();
          console.error(dErr);
          return res.status(500).json({ error: "Duplicate check failed" });
        }
        if (dup) {
          clear();
          return res.status(409).json({ error: "Phone already exists" });
        }

        db.run(
          `
            UPDATE clients SET
              name = ?, phone = ?, email = ?, notes = ?, language = ?, office = ?,
              case_type = ?, case_subtype = ?,
              appt_setter = ?, ic = ?, attorney_assigned = ?, intake_coordinator = ?,
              appt_date = ?, appt_time = ?
            WHERE id = ?
          `,
          [
            merged.name,
            merged.phone,
            merged.email,
            merged.notes,
            merged.language,
            merged.office,
            merged.case_type,
            merged.case_subtype,
            merged.appt_setter,
            merged.ic,
            merged.attorney_assigned, // ✅ NEW
            merged.intake_coordinator,
            merged.appt_date,
            merged.appt_time,
            id,
          ],
          (uErr) => {
            if (uErr) {
              clear();
              console.error(uErr);
              return res.status(500).json({ error: "Update failed" });
            }

            db.get("SELECT * FROM clients WHERE id = ?", [id], (fErr, row2) => {
              clear();
              if (fErr) {
                console.error(fErr);
                return res.status(500).json({ error: "Fetch failed" });
              }
              return res.json(row2);
            });
          }
        );
      });
    });
  } catch (e) {
    clear();
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * PUT /api/clients/:id/status
 */
router.put("/:id/status", (req, res) => {
  const clear = withTimeout(res, "PUT /api/clients/:id/status");
  const { status_id } = req.body || {};

  db.run("UPDATE clients SET status_id = ? WHERE id = ?", [status_id || null, req.params.id], (err) => {
    clear();
    if (err) {
      console.error(err);
      return res.status(500).json({ success: false });
    }
    return res.json({ success: true });
  });
});

/**
 * DELETE /api/clients/:id
 */
router.delete("/:id", (req, res) => {
  const clear = withTimeout(res, "DELETE /api/clients/:id");

  db.run("DELETE FROM messages WHERE client_id = ?", [req.params.id], () => {
    db.run("DELETE FROM clients WHERE id = ?", [req.params.id], (err) => {
      clear();
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "Delete failed" });
      }
      return res.json({ success: true });
    });
  });
});

module.exports = router;

