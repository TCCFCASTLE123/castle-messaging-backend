const express = require("express");
const router = express.Router();
const db = require('../db.js');
const { sendSmsAndLog } = require('../utils/sms');
const normalizePhone = require('../utils/normalizePhone');

// Fill placeholders in message templates
function fillTemplatePlaceholders(template, client) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (key === 'ClientFirstName') {
      return client.name ? client.name.split(' ')[0] : "";
    }
    return client[key] || "";
  });
}

// Get status name by id
function getStatusName(status_id, cb) {
  db.get("SELECT name FROM statuses WHERE id = ?", [status_id], (err, row) => {
    cb(err || !row ? "" : row.name);
  });
}

// Try the best match, then fallback to "any" office/case_type (null/empty)
function selectTemplate({ status, office, case_type, language }, cb) {
  // Try the most specific match first
  db.get(
    `SELECT * FROM templates
     WHERE status = ?
       AND office = ?
       AND case_type = ?
       AND language = ?
       AND active = 1
     ORDER BY id DESC LIMIT 1`,
    [status, office, case_type, language],
    (err, tpl) => {
      if (err) return cb(err);
      if (tpl) {
        console.log("Specific match found:", tpl); // <-- ADD THIS
        return cb(null, tpl);
      }

      // Fallback: match Any Office/Any Case Type (null/empty)
      db.get(
        `SELECT * FROM templates
         WHERE status = ?
           AND (office IS NULL OR office = '')
           AND (case_type IS NULL OR case_type = '')
           AND language = ?
           AND active = 1
         ORDER BY id DESC LIMIT 1`,
        [status, language],
        (err2, tpl2) => {
          if (tpl2) {
            console.log("Fallback match found:", tpl2); // <-- ADD THIS
          } else {
            console.log("No template found for", {status, office, case_type, language});
          }
          cb(err2, tpl2);
        }
      );
    }
  );
}

// GET all clients
router.get("/", (req, res) => {
  db.all("SELECT * FROM clients", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// PATCH client (edit client)
router.patch('/:id', (req, res) => {
  const {
    name, phone, email, notes, language, office, case_type, status_id,
    AppointmentScheduledDate, ClientFirstName
  } = req.body;
  const normalizedPhone = normalizePhone(phone);

  db.run(
    `UPDATE clients SET name=?, phone=?, email=?, notes=?, language=?, office=?, case_type=?, status_id=?, AppointmentScheduledDate=?, ClientFirstName=? WHERE id=?`,
    [name, normalizedPhone, email, notes, language, office, case_type, status_id, AppointmentScheduledDate, ClientFirstName, req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: 'Failed to update client' });

      getStatusName(status_id, (statusStr) => {
        if (!statusStr) return res.json({ success: true, warning: "No status string found" });

        selectTemplate({ status: statusStr, office, case_type, language }, (err2, template) => {
          if (err2) return res.json({ success: true, warning: "Template lookup failed" });
          if (template) {
            const clientObj = {
              name, phone: normalizedPhone, email, notes, language, office, case_type, status: statusStr,
              AppointmentScheduledDate, ClientFirstName
            };
            const msgText = fillTemplatePlaceholders(template.template, clientObj);

            if (Number(template.delay_hours) === 0) {
              sendSmsAndLog(db, normalizedPhone, msgText, req.params.id, 'system', () => res.json({ success: true }));
            } else {
              db.run(
                `INSERT INTO scheduled_messages (client_id, template_id, send_time, text)
                 VALUES (?, ?, ?, ?)`,
                [
                  req.params.id,
                  template.id,
                  Date.now() + Number(template.delay_hours) * 60 * 60 * 1000,
                  msgText
                ],
                () => res.json({ success: true })
              );
            }
          } else {
            res.json({ success: true });
          }
        });
      });
    }
  );
});

// ADD a client (with dupe check)
router.post("/", (req, res) => {
  const {
    name, phone, email, notes, language, office, case_type, status_id,
    AppointmentScheduledDate, ClientFirstName
  } = req.body;
  if (!name) return res.status(400).json({ error: "Name is required" });
  const normalizedPhone = normalizePhone(phone);

  db.get("SELECT * FROM clients WHERE phone = ?", [normalizedPhone], (err, existingClient) => {
    if (err) return res.status(500).json({ error: err.message });
    if (existingClient) {
      return res.status(409).json({ error: "A client with this phone number already exists.", client: existingClient });
    }

    db.run(
      `INSERT INTO clients (name, phone, email, notes, language, office, case_type, status_id, AppointmentScheduledDate, ClientFirstName)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, normalizedPhone, email, notes, language, office, case_type, status_id, AppointmentScheduledDate, ClientFirstName],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });

        const clientId = this.lastID;
        getStatusName(status_id, (statusStr) => {
          if (!statusStr) return res.json({
            id: clientId, name, phone: normalizedPhone, email, notes, language, office, case_type, status_id, AppointmentScheduledDate, ClientFirstName,
            warning: "No status string found"
          });

          selectTemplate({ status: statusStr, office, case_type, language }, (err2, template) => {
            if (err2) return res.json({
              id: clientId, name, phone: normalizedPhone, email, notes, language, office, case_type, status_id, AppointmentScheduledDate, ClientFirstName,
              warning: "Template lookup failed"
            });
            if (template) {
              const clientObj = {
                name, phone: normalizedPhone, email, notes, language, office, case_type, status: statusStr,
                AppointmentScheduledDate, ClientFirstName
              };
              const msgText = fillTemplatePlaceholders(template.template, clientObj);

              if (Number(template.delay_hours) === 0) {
                sendSmsAndLog(db, normalizedPhone, msgText, clientId, 'system', () =>
                  res.json({ id: clientId, name, phone: normalizedPhone, email, notes, language, office, case_type, status_id, AppointmentScheduledDate, ClientFirstName })
                );
              } else {
                db.run(
                  `INSERT INTO scheduled_messages (client_id, template_id, send_time, text)
                   VALUES (?, ?, ?, ?)`,
                  [
                    clientId,
                    template.id,
                    Date.now() + Number(template.delay_hours) * 60 * 60 * 1000,
                    msgText
                  ],
                  () =>
                    res.json({ id: clientId, name, phone: normalizedPhone, email, notes, language, office, case_type, status_id, AppointmentScheduledDate, ClientFirstName })
                );
              }
            } else {
              res.json({ id: clientId, name, phone: normalizedPhone, email, notes, language, office, case_type, status_id, AppointmentScheduledDate, ClientFirstName });
            }
          });
        });
      }
    );
  });
});

// DELETE a client by id
router.delete("/:id", (req, res) => {
  const { id } = req.params;
  db.run("DELETE FROM clients WHERE id = ?", [id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: "Client not found" });

    db.run("DELETE FROM messages WHERE client_id = ?", [id], function (msgErr) {
      if (msgErr) {
        console.error("Failed to delete client messages:", msgErr);
      }
      res.json({ success: true, message: "Client and messages deleted" });
    });
  });
});

// UPDATE ONLY STATUS (status dropdown)
router.put('/:id/status', (req, res) => {
  const { id } = req.params;
  const { status_id } = req.body;
  if (!status_id) return res.status(400).json({ error: "status_id is required" });

  getStatusName(status_id, (statusStr) => {
    if (!statusStr) return res.status(500).json({ error: "Status name lookup failed" });

    db.get("SELECT * FROM clients WHERE id = ?", [id], (err2, client) => {
      if (err2 || !client) return res.json({ success: true, warning: "Client not found for template matching" });

      db.run(
        "UPDATE clients SET status_id = ? WHERE id = ?",
        [status_id, id],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });
          if (this.changes === 0) return res.status(404).json({ error: "Client not found" });

          selectTemplate({
            status: statusStr,
            office: client.office,
            case_type: client.case_type,
            language: client.language
          }, (err3, template) => {
            if (err3) return res.json({ success: true, warning: "Template lookup failed" });

            if (template) {
              const clientObj = {
                name: client.name,
                phone: client.phone,
                email: client.email,
                notes: client.notes,
                language: client.language,
                office: client.office,
                case_type: client.case_type,
                status: statusStr,
                AppointmentScheduledDate: client.AppointmentScheduledDate,
                ClientFirstName: client.ClientFirstName
              };
              const msgText = fillTemplatePlaceholders(template.template, clientObj);

              if (Number(template.delay_hours) === 0) {
                sendSmsAndLog(db, client.phone, msgText, client.id, 'system', () => res.json({ success: true }));
              } else {
                db.run(
                  `INSERT INTO scheduled_messages (client_id, template_id, send_time, text)
                   VALUES (?, ?, ?, ?)`,
                  [
                    client.id,
                    template.id,
                    Date.now() + Number(template.delay_hours) * 60 * 60 * 1000,
                    msgText
                  ],
                  () => res.json({ success: true })
                );
              }
            } else {
              res.json({ success: true });
            }
          });
        }
      );
    });
  });
});

module.exports = router;
