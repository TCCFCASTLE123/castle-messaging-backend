// lib/enqueueTemplates.js
// Enqueue templates when a client's status changes (Option B behavior)

const db = require("../db");

/**
 * Enqueue templates for a client when a trigger condition is met.
 * Requires client.status (TEXT), not just status_id.
 */
function enqueueTemplatesForClient(client) {
  return new Promise((resolve, reject) => {
    // 🔥 SAFETY: status MUST be present
    if (!client.status) {
      console.warn(
        "⚠️ enqueueTemplatesForClient called without client.status",
        client.id
      );
      return resolve(0);
    }

    const {
      id: client_id,
      status,               // TEXT name like "No Show"
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
        status,
        office || "",
        case_type || "",
        appointment_type || "",
        language || "",
      ],
      async (err, templates) => {
        if (err) return reject(err);

        if (!templates || templates.length === 0) {
          console.log("ℹ️ No matching templates for client", client_id);
          return resolve(0);
        }

        let enqueued = 0;
        const nowMs = Date.now();

        for (const t of templates) {
          const delayMs =
            Number(t.delay_hours || 0) * 60 * 60 * 1000;

          const sendTimeMs = nowMs + delayMs;

          // Idempotency per status
          const exists = await new Promise((res, rej) => {
            db.get(
              `
              SELECT id
              FROM scheduled_messages
              WHERE client_id = ?
                AND template_id = ?
                AND trigger_status = ?
              `,
              [client_id, t.id, status],
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
                trigger_status,
                send_time,
                message,
                status,
                attempts,
                created_at,
                updated_at
              )
              VALUES (?, ?, ?, ?, ?, 'pending', 0, datetime('now'), datetime('now'))
              `,
              [
                client_id,
                t.id,
                status,
                sendTimeMs,
                t.template,
              ],
              (e) => (e ? rej(e) : res())
            );
          });

          enqueued++;
        }

        console.log(
          `📥 Enqueued ${enqueued} template(s) for client ${client_id} (status=${status})`
        );

        resolve(enqueued);
      }
    );
  });
}

module.exports = { enqueueTemplatesForClient };
