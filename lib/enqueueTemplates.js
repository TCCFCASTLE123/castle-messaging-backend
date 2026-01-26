// lib/enqueueTemplates.js
// Turns active templates into scheduled_messages for a client
// ✅ ISO DATETIME ONLY — NO MS

const db = require("../db");

function addMinutesIso(baseDate, minutes) {
  const d = new Date(baseDate);
  d.setMinutes(d.getMinutes() + minutes);
  return d.toISOString();
}

function enqueueTemplatesForClient(client) {
  return new Promise((resolve, reject) => {
    const {
      id: client_id,
      status,
      office,
      case_type,
      appointment_type,
      language,
    } = client;

    const sql = `
      SELECT *
      FROM templates
      WHERE active = 1
        AND (status = '' OR status = ?)
        AND (office = '' OR office = ?)
        AND (case_type = '' OR case_type = ?)
        AND (appointment_type = '' OR appointment_type = ?)
        AND (language = '' OR language = ?)
    `;

    db.all(
      sql,
      [
        status || "",
        office || "",
        case_type || "",
        appointment_type || "",
        language || "",
      ],
      async (err, templates) => {
        if (err) return reject(err);
        if (!templates?.length) return resolve(0);

        const nowIso = new Date().toISOString();
        let enqueued = 0;

        for (const t of templates) {
          const delayMinutes = Number(t.delay_hours || 0) * 60;
          const send_time = addMinutesIso(nowIso, delayMinutes);

          // Idempotency
          const exists = await new Promise((res, rej) => {
            db.get(
              `
              SELECT id FROM scheduled_messages
              WHERE client_id = ? AND template_id = ?
              `,
              [client_id, t.id],
              (e, row) => (e ? rej(e) : res(row))
            );
          });

          if (exists) continue;

          await new Promise((res, rej) => {
            db.run(
              `
              INSERT INTO scheduled_messages
              (
                client_id,
                template_id,
                send_time,
                message,
                status,
                attempts,
                created_at,
                updated_at
              )
              VALUES (?, ?, ?, ?, 'pending', 0, datetime('now'), datetime('now'))
              `,
              [client_id, t.id, send_time, t.template],
              (e) => (e ? rej(e) : res())
            );
          });

          enqueued++;
        }

        console.log(`📥 Enqueued ${enqueued} template(s) for client ${client_id}`);
        resolve(enqueued);
      }
    );
  });
}

module.exports = { enqueueTemplatesForClient };
