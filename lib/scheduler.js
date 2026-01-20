// lib/scheduler.js
// Sends scheduled messages from scheduled_messages table

const db = require("../db");
const twilio = require("twilio");

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const FROM_NUMBER = process.env.TWILIO_FROM;
const POLL_INTERVAL = 15 * 1000; // 15 seconds

async function sendScheduledMessage({ to, message }) {
  const msg = await client.messages.create({
    from: FROM_NUMBER,
    to,
    body: message,
  });
  return msg.sid;
}

async function processQueue(io) {
  const now = new Date().toISOString();

  db.all(
    `
    SELECT sm.*, c.phone
    FROM scheduled_messages sm
    JOIN clients c ON c.id = sm.client_id
    WHERE sm.status = 'pending'
      AND sm.send_time <= ?
    ORDER BY sm.send_time ASC
    LIMIT 10
    `,
    [now],
    async (err, rows) => {
      if (err) {
        console.error("❌ Scheduler SELECT failed:", err.message);
        return;
      }

      if (!rows.length) return;

      for (const row of rows) {
        const to = `+1${row.phone}`;

        db.run(
          `UPDATE scheduled_messages
           SET status='sending', attempts = attempts + 1
           WHERE id=?`,
          [row.id]
        );

        try {
          const sid = await sendScheduledMessage({
            to,
            message: row.message,
          });

          db.run(
            `
            UPDATE scheduled_messages
            SET status='sent',
                sent_at=datetime('now'),
                updated_at=datetime('now')
            WHERE id=?
            `,
            [row.id]
          );

          db.run(
            `
            INSERT INTO messages (client_id, sender, text, direction, external_id)
            VALUES (?, 'system', ?, 'outbound', ?)
            `,
            [row.client_id, row.message, sid]
          );

          console.log("✅ Scheduled message sent:", row.id);

          if (io) {
            io.emit("message_sent", {
              client_id: row.client_id,
              text: row.message,
            });
          }
        } catch (e) {
          console.error("❌ Scheduled send failed:", e.message);

          db.run(
            `
            UPDATE scheduled_messages
            SET status='failed',
                last_error=?,
                updated_at=datetime('now')
            WHERE id=?
            `,
            [e.message, row.id]
          );
        }
      }
    }
  );
}

function startScheduler(io) {
  console.log("⏱️ Scheduler started");

  setInterval(() => {
    processQueue(io);
  }, POLL_INTERVAL);
}

module.exports = { startScheduler };
