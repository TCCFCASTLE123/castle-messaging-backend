// lib/enqueueTemplates.js
// Turns active templates into scheduled_messages for a client (SAFE + IDEMPOTENT)

const db = require("../db");

/**
 * Enqueue templates for a client when a trigger condition is met.
 * Idempotent: will not enqueue the same template twice for the same client.
 */
function enqueueTemplatesForClient(client) {
  return new Promise((resolve, reject) => {
    try {
      const {
        id: client_id,
        status,
        office,
        case_type,
        appointment_type,
        language,
      } = client;

      if (!client_id) {
        return resolve(0);
      }

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

          if (!templates || templates.length === 0) {
            console.log("ℹ️ No matching templates for client", client_id);
            return resolve(0);
          }

          const nowIso = new Date().toISOString();
          let enqueued = 0;

          for (const t of templates) {
            const delayMs =
              Number(t.delay_hours || 0) * 60 * 60 * 1000;
            const sendTimeIso = new Date(Date.now() + delayMs).toISOString();

            // ---- Idempotency check ----
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

            // ---- Safe insert ----
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
                VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
                `,
                [
                  client_id,
                  t.id,
                  sendTimeIso,
                  t.template,
                  nowIso,
                  nowIso,
                ],
                (e) => (e ? rej(e) : res())
              );
            });

            enqueued++;
          }

          console.log(
            `📥 Enqueued ${enqueued} template message(s) for client ${client_id}`
          );

          resolve(enqueued);
        }
      );
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { enqueueTemplatesForClient };
