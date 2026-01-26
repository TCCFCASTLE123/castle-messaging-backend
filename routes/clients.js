// routes/clients.js — FINAL, SAFE, STATUS ROUTE RESTORED

const express = require("express");
const router = express.Router();
const db = require("../db");
const { enqueueTemplatesForClient } = require("../lib/enqueueTemplates");

// -------------------- HELPERS --------------------

function canonicalPhone(input) {
  if (!input) return "";
  const digits = String(input).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

function cleanPatchValue(v) {
  if (v === undefined || v === "") return undefined;
  return v;
}

function withTimeout(res, label, ms = 12000) {
  const t = setTimeout(() => {
    console.error(`❌ ${label} timed out after ${ms}ms`);
    if (!res.headersSent) res.status(504).json({ error: "Request timed out" });
  }, ms);
  return () => clearTimeout(t);
}

// -------------------- GET CLIENTS --------------------

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
      if (err) return res.status(500).json({ error: "Failed to load clients" });
      res.json(rows || []);
    }
  );
});

// -------------------- CREATE CLIENT --------------------

router.post("/", (req, res) => {
  const clear = withTimeout(res, "POST /api/clients");

  const { name, phone } = req.body || {};
  const cleanName = (name || "").trim();
  const cleanPhone = canonicalPhone(phone);

  if (!cleanName || cleanPhone.length !== 10) {
    clear();
    return res.status(400).json({ error: "Invalid name or phone" });
  }

  db.run(
    "INSERT INTO clients (name, phone) VALUES (?, ?)",
    [cleanName, cleanPhone],
    function (err) {
      clear();
      if (err) return res.status(500).json({ error: "Insert failed" });
      res.json({ id: this.lastID });
    }
  );
});

// -------------------- PATCH CLIENT (GENERAL EDITS) --------------------

router.patch("/:id", (req, res) => {
  const clear = withTimeout(res, "PATCH /api/clients/:id");
  const id = req.params.id;
  const body = req.body || {};

  db.get("SELECT * FROM clients WHERE id = ?", [id], (err, existing) => {
    if (err || !existing) {
      clear();
      return res.status(404).json({ error: "Client not found" });
    }

    const oldStatusId = existing.status_id;

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
      status_id:
        cleanPatchValue(body.status_id) !== undefined
          ? body.status_id
          : existing.status_id,
    };

    db.run(
      `
      UPDATE clients SET
        name=?, phone=?, email=?, notes=?, language=?, office=?,
        case_type=?, case_subtype=?, appt_setter=?, ic=?,
        attorney_assigned=?, intake_coordinator=?,
        appt_date=?, appt_time=?, status_id=?
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
        merged.status_id,
        id,
      ],
      (uErr) => {
        if (uErr) {
          clear();
          return res.status(500).json({ error: "Update failed" });
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
            clear();
            if (fErr) return res.status(500).json({ error: "Reload failed" });

            if (
              body.status_id !== undefined &&
              Number(oldStatusId) !== Number(merged.status_id)
            ) {
              try {
                await enqueueTemplatesForClient(updatedClient);
              } catch (e) {
                console.error("❌ Template enqueue failed:", e.message);
              }
            }

            res.json(updatedClient);
          }
        );
      }
    );
  });
});

// ===================================================================
// 🔥 PUT /api/clients/:id/status  (RESTORED FOR FRONTEND)
// ===================================================================

router.put("/:id/status", (req, res) => {
  const clear = withTimeout(res, "PUT /api/clients/:id/status");
  const clientId = req.params.id;
  const { status_id } = req.body || {};

  if (!status_id) {
    clear();
    return res.status(400).json({ error: "status_id required" });
  }

  db.get("SELECT * FROM clients WHERE id = ?", [clientId], (err, existing) => {
    if (err || !existing) {
      clear();
      return res.status(404).json({ error: "Client not found" });
    }

    const oldStatusId = existing.status_id;

    db.run(
      "UPDATE clients SET status_id = ? WHERE id = ?",
      [status_id, clientId],
      (uErr) => {
        if (uErr) {
          clear();
          return res.status(500).json({ error: "Update failed" });
        }

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
            if (fErr) return res.status(500).json({ error: "Reload failed" });

            if (Number(oldStatusId) !== Number(status_id)) {
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
  });
});

// -------------------- DELETE CLIENT --------------------

// -------------------- DELETE CLIENT (FULL CASCADE) --------------------

router.delete("/:id", (req, res) => {
  const clear = withTimeout(res, "DELETE /api/clients/:id");
  const clientId = req.params.id;

  db.serialize(() => {
    db.run("BEGIN TRANSACTION");

    db.run(
      "DELETE FROM scheduled_messages WHERE client_id = ?",
      [clientId],
      (err) => {
        if (err) {
          db.run("ROLLBACK");
          clear();
          console.error("❌ Failed deleting scheduled_messages:", err.message);
          return res.status(500).json({ error: "Failed deleting scheduled messages" });
        }

        db.run(
          "DELETE FROM messages WHERE client_id = ?",
          [clientId],
          (err2) => {
            if (err2) {
              db.run("ROLLBACK");
              clear();
              console.error("❌ Failed deleting messages:", err2.message);
              return res.status(500).json({ error: "Failed deleting messages" });
            }

            db.run(
              "DELETE FROM clients WHERE id = ?",
              [clientId],
              function (err3) {
                if (err3) {
                  db.run("ROLLBACK");
                  clear();
                  console.error("❌ Failed deleting client:", err3.message);
                  return res.status(500).json({ error: "Failed deleting client" });
                }

                db.run("COMMIT");
                clear();

                return res.json({
                  success: true,
                  deleted_client_id: clientId,
                });
              }
            );
          }
        );
      }
    );
  });
});

module.exports = router;

