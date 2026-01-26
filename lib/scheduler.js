// lib/scheduler.js
// Polls scheduled_messages and sends due messages via Twilio (CRASH-PROOF)

const db = require("../db");
const twilio = require("twilio");

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const FROM_NUMBER = process.env.TWILIO_FROM;
const POLL_INTERVAL_MS = 15 * 1000;
const MAX_ATTEMPTS = 5;

async function sendSMS(to, body) {
  const msg = await client.messages.create({
    from: FROM_NUMBER,
    to,
    body,
  });
  return msg.sid;
}

function startScheduler(io) {
  if (
    !process.env.TWILIO_ACCOUNT_SID ||
    !process.env.TWILIO_AUTH_TOKEN ||
    !FROM_NUMBER
  ) {
    console.error("❌ Scheduler NOT started — missing Twilio env vars");
    return;
  }

  console.log("⏱️ Scheduler started");

  setTimeout(() => {
    processQueue(io).catch((e) =>
      console.error("❌ Scheduler fatal error:", e)
    );
    setInterval(() => {
      processQueue(io).catch((e) =>
        console.error("❌ Scheduler fatal error:", e)
      );
    }, POLL_INTERVAL_MS);
  }, 2000);
}

async function processQueue(io) {
  console.log(`⏱️ Scheduler tick @ ${new Date().toISOString()}`);

  const rows = await query(
    `
    SELECT sm.*, c.phone
    FROM scheduled_messages sm
    JOIN clients c ON c.id = sm.client_id
    WHERE sm.status = 'pending'
      AND datetime(sm.send_time) <= datetime('now')
      AND COALESCE(sm.attempts, 0) < ?
    ORDER BY datetime(sm.send_time) ASC
    LIMIT 10
    `,
    [MAX_ATTEMPTS]
  );

  console.log(`📬 Due messages found: ${rows.length}`);

  for (const row of rows) {
    const to = `+1${row.phone}`;

    // 🔥 SAFE increment (never NULL)
    await exec(
      `
      UPDATE scheduled_messages
      SET status = 'sending',
          attempts = COALESCE(attempts, 0) + 1,
          updated_at = datetime('now')
      WHERE id = ?
      `,
      [row.id]
    );

    try {
      const sid = await sendSMS(to, row.message);

      await exec(
        `
        UPDATE scheduled_messages
        SET status = 'sent',
            sent_at = datetime('now'),
            updated_at = datetime('now')
        WHERE id = ?
        `,
        [row.id]
      );

      await exec(
        `
        INSERT INTO messages
          (client_id, sender, text, direction, external_id)
        VALUES
          (?, 'system', ?, 'outbound', ?)
        `,
        [row.client_id, row.message, sid]
      );

      io?.emit("message_sent", {
        client_id: row.client_id,
        text: row.message,
        direction: "outbound",
      });
    } catch (e) {
      await exec(
        `
        UPDATE scheduled_messages
        SET status = 'failed',
            last_error = ?,
            updated_at = datetime('now')
        WHERE id = ?
        `,
        [String(e.message || e), row.id]
      );

      console.error("❌ Scheduler send failed:", e.message);
    }
  }
}

// -------------------- DB HELPERS --------------------

function query(sql, params = []) {
  return new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) =>
      err ? reject(err) : resolve(rows || [])
    )
  );
}

function exec(sql, params = []) {
  return new Promise((resolve, reject) =>
    db.run(sql, params, (err) =>
      err ? reject(err) : resolve()
    )
  );
}

module.exports = { startScheduler };
