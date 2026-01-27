// lib/enqueueTemplates.js

const db = require("../db");

function sqliteNowPlusHours(hours = 0) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT datetime('now', ? || ' hours') AS send_time`,
      [Number(hours)],
      (err, row) => {
        if (err) reject(err);
        else resolve(row.send_time);
      }
    );
  });
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

        let enqueued = 0;

        for (const t of templates) {
          const exists = await new Promise((res, rej) => {
            db.get(
              `
              SELECT id
              FROM scheduled_messages
              WHERE client_id = ?
                AND template_id = ?
              `,
              [client_id, t.id],
              (e, row) => (e ? rej(e) : res(row))
            );
          });

          if (exists) continue;

          const send_time = await sqliteNowPlusHours(t.delay_hours || 0);

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
              [
                client_id,
                t.id,
                send_time,
                t.template,
              ],
              (e) => (e ? rej(e) : res())
            );
          });

          enqueued++;
        }

        console.log(`📥 Enqueued ${enqueued} templates for client ${client_id}`);
        resolve(enqueued);
      }
    );
  });
}

module.exports = { enqueueTemplatesForClient };
