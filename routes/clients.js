// routes/clients.js — CLEAN + SAFE (templates enqueue on status change)

const express = require("express");
const router = express.Router();
const db = require("../db");
const { enqueueTemplatesForClient } = require("../lib/enqueueTemplates");
const oldStatusId = existing.status_id;

// -------------------- HELPERS --------------------

function canonicalPhone(input) {
  if (!input) return "";
  const digits = String(input).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

// Treat "" as "not provided" for PATCH so we don't wipe existing values.
function cleanPatchValue(v) {
  if (v === undefined) return undefined;
  if (v === "") return undefined;
  return v;
}

// Optional timeout guard
function withTimeout(res, label, ms = 12000) {
  const t = setTimeout(() => {
    console.error(`❌ ${label} timed out after ${ms}ms`);
    if (!res.headersSent) res.status(504).json({ error: "Request timed out" });
  }, ms);
  return () => clearTimeout(t);
}

// -------------------- GET ALL CLIENTS --------------------

router.get("/", (req, res) => {
  const clear = withTimeout(res, "GET /api/clients");

  db.all(
    `
    SELECT c.*, s.name AS status
    FROM clients c
    LEFT JOIN statuses s ON s.id = c.status_id
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
      res.json(rows || []);
    }
  );
});

// -------------------- CREATE CLIENT --------------------

router.post("/", (req, res) => {
  const clear = withTimeout(res, "POST /api/clients");

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
    attorney_assigned,
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
    return res.status(400).json({ error: "Phone must be 10 digits" });
  }

  db.get("SELECT id FROM clients WHERE phone = ?", [cleanPhone], (err, row) => {
    if (err) {
      clear();
      return res.status(500).json({ error: "Lookup failed" });
    }
    if (row) {
      clear();
      return res.status(409).json({ error: "Phone already exists" });
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
        attorney_assigned || null,
        intake_coordinator || null,
        appt_date || null,
        appt_time || null,
      ],
      function (err2) {
        clear();
        if (err2) {
          console.error(err2);
          return res.status(500).json({ error: "Insert failed" });
        }

  db.get(
  `
  SELECT c.*, s.name AS status
  FROM clients c
  LEFT JOIN statuses s ON s.id = c.status_id
  WHERE c.id = ?
  `,
  [id],
  async (fErr, updatedClient) => {
    if (fErr) {
      clear();
      return res.status(500).json({ error: "Fetch failed" });
    }

    // 🔥 TRIGGER TEMPLATES IF STATUS CHANGED
    if (
      req.body.status_id &&
      Number(req.body.status_id) !== Number(oldStatusId)
    ) {
      try {
        await enqueueTemplatesForClient(updatedClient);
      } catch (e) {
        console.error("❌ Template enqueue failed:", e.message);
      }
    }

    clear();
    res.json(updatedClient);
  }
);

    );
  });
});

// -------------------- PATCH CLIENT --------------------

router.patch("/:id", (req, res) => {
  const clear = withTimeout(res, "PATCH /api/clients/:id");
  const id = req.params.id;

  db.get("SELECT * FROM clients WHERE id = ?", [id], (err, existing) => {
    if (err || !existing) {
      clear();
      return res.status(404).json({ error: "Client not found" });
    }

    const body = req.body || {};

    const merged = {
      name: cleanPatchValue(body.name) ?? existing.name,
      phone:
        cleanPatchValue(body.phone) !== undefined
          ? canonicalPhone(body.phone)
          : existing.phone,
      email: cleanPatchValue(body.email) ?? existing.email,
      notes: cleanPatchValue(body.notes) ?? existing.notes,
      language: cleanPatchValue(body.language) ?? existing.language,
      office: cleanPatchValue(body.office) ?? existing.office,
      case_type: cleanPatchValue(body.case_type) ?? existing.case_type,
      case_subtype: cleanPatchValue(body.case_subtype) ?? existing.case_subtype,
      appt_setter: cleanPatchValue(body.appt_setter) ?? existing.appt_setter,
      ic: cleanPatchValue(body.ic) ?? existing.ic,
      attorney_assigned:
        cleanPatchValue(body.attorney_assigned) ?? existing.attorney_assigned,
      intake_coordinator:
        cleanPatchValue(body.intake_coordinator) ??
        existing.intake_coordinator,
      appt_date: cleanPatchValue(body.appt_date) ?? existing.appt_date,
      appt_time: cleanPatchValue(body.appt_time) ?? existing.appt_time,
    };

    if (!merged.name || merged.phone.length !== 10) {
      clear();
      return res.status(400).json({ error: "Invalid name or phone" });
    }

    db.run(
      `
      UPDATE clients SET
        name=?, phone=?, email=?, notes=?, language=?, office=?,
        case_type=?, case_subtype=?,
        appt_setter=?, ic=?, attorney_assigned=?, intake_coordinator=?,
        appt_date=?, appt_time=?
      WHERE id=?
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
        merged.attorney_assigned,
        merged.intake_coordinator,
        merged.appt_date,
        merged.appt_time,
        id,
      ],
      (uErr) => {
        clear();
        if (uErr) return res.status(500).json({ error: "Update failed" });

        db.get("SELECT * FROM clients WHERE id = ?", [id], (fErr, row2) => {
          if (fErr) return res.status(500).json({ error: "Fetch failed" });
          res.json(row2);
        });
      }
    );
  });
});

// ===================================================================
// 🔥 PUT /api/clients/:id/status
// 🔥 Triggers template enqueue on REAL status change
// ===================================================================

router.put("/:id/status", (req, res) => {
  const clear = withTimeout(res, "PUT /api/clients/:id/status");
  const clientId = req.params.id;
  const { status_id } = req.body || {};

  if (!status_id) {
    clear();
    return res.status(400).json({ error: "status_id required" });
  }

  // Load old status
  db.get(
    `
    SELECT c.*, s.name AS status_name
    FROM clients c
    LEFT JOIN statuses s ON s.id = c.status_id
    WHERE c.id = ?
    `,
    [clientId],
    (err, oldClient) => {
      if (err || !oldClient) {
        clear();
        return res.status(404).json({ error: "Client not found" });
      }

      const oldStatus = oldClient.status_name || "";

      // Update status_id
      db.run(
        "UPDATE clients SET status_id = ? WHERE id = ?",
        [status_id, clientId],
        (uErr) => {
          if (uErr) {
            clear();
            return res.status(500).json({ error: "Update failed" });
          }

          // Reload client with new status
          db.get(
            `
            SELECT c.*, s.name AS status
            FROM clients c
            LEFT JOIN statuses s ON s.id = c.status_id
            WHERE c.id = ?
            `,
            [clientId],
            async (fErr, updatedClient) => {
              clear();
              if (fErr || !updatedClient) {
                return res.status(500).json({ error: "Reload failed" });
              }

              const newStatus = updatedClient.status || "";

              // 🔥 ACTUAL TRIGGER
              if (oldStatus !== newStatus) {
                try {
                  await enqueueTemplatesForClient(updatedClient);
                } catch (e) {
                  console.error("❌ Template enqueue failed:", e.message);
                }
              }

              res.json({ success: true, client: updatedClient });
            }
          );
        }
      );
    }
  );
});

// -------------------- DELETE CLIENT --------------------

router.delete("/:id", (req, res) => {
  const clear = withTimeout(res, "DELETE /api/clients/:id");

  db.run("DELETE FROM messages WHERE client_id = ?", [req.params.id], () => {
    db.run("DELETE FROM clients WHERE id = ?", [req.params.id], (err) => {
      clear();
      if (err) return res.status(500).json({ error: "Delete failed" });
      res.json({ success: true });
    });
  });
});

module.exports = router;

