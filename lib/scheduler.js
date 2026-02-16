// lib/scheduler.js
// PRODUCTION SAFE SCHEDULER (Defensive Version)

const db = require("../db");
const twilio = require("twilio");

const POLL_INTERVAL_MS = 15 * 1000;
const MAX_GLOBAL_PER_TICK = 5;
const MAX_ATTEMPTS = 5;
const MAX_LATE_WINDOW_MINUTES = 10; // do not send messages overdue beyond this window

function startScheduler(io) {
  if (process.env.SCHEDULER_ENABLED !== "true") {
    console.log("⛔ Scheduler disabled via SCHEDULER_ENABLED");
    return;
  }

  if (
    !process.env.TWILIO_ACCOUNT_SID ||
    !process.env.TWILIO_AUTH_TOKEN ||
    !process.env.TWILIO_FROM
  ) {
    console.error("❌ Scheduler NOT started — missing Twilio env vars");
    return;
  }

  const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  console.log("🟢 Scheduler started (SAFE MODE)");

  setInterval(() => {
    processQueue(client, io).catch((err) => {
      console.error("❌ Scheduler loop error:", err);
    });
  }, POLL_INTERVAL_MS);
}

async function processQueue(twilioClient, io) {
  console.log("⏱ Scheduler tick @", new Date().toISOString());

  const rows = await query(`
    SELECT sm.*, c.phone
    FROM scheduled_messages sm
    JOIN clients c ON c.id = sm.client_id
    WHERE sm.status = 'pending'
      AND sm.attempts < ?
      AND sm.send_time <= datetime('now')
      AND sm.send_time >= datetime('now', ?)
    ORDER BY sm.send_time ASC
    LIMIT ?
  `, [
    MAX_ATTEMPTS,
    `-${MAX_LATE_WINDOW_MINUTES} minutes`,
    MAX_GLOBAL_PER_TICK
  ]);

  console.log("📬 Eligible messages:", rows.length);
  if (!rows.length) return;

  const processedClients = new Set();

  for (const row of rows) {
    if (processedClients.has(row.client_id)) continue;
    processedClients.add(row.client_id);

    const to = `+1${row.phone}`;

    await run(`
      UPDATE scheduled_messages
      SET status = 'sending',
          attempts = attempts + 1,
          updated_at = datetime('now')
      WHERE id = ?
    `, [row.id]);

    try {
      const msg = await twilioClient.messages.create({
        from: process.env.TWILIO_FROM,
        to,
        body: row.message,
      });

      await run(`
        UPDATE scheduled_messages
        SET status = 'sent',
            sent_at = datetime('now'),
            updated_at = datetime('now')
        WHERE id = ?
      `, [row.id]);

      await run(`
        INSERT INTO messages
        (client_id, sender, text, direction, external_id)
        VALUES (?, 'system', ?, 'outbound', ?)
      `, [row.client_id, row.message, msg.sid]);

      io?.emit("message_sent", {
        client_id: row.client_id,
        text: row.message,
        direction: "outbound",
      });

      console.log("✅ Sent scheduled message:", row.id);

    } catch (e) {
      await run(`
        UPDATE scheduled_messages
        SET status = 'failed',
            last_error = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `, [e.message, row.id]);

      console.error("❌ Send failed:", e.message);
    }
  }
}

function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) =>
      err ? reject(err) : resolve(rows || [])
    );
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err) =>
      err ? reject(err) : resolve()
    );
  });
}

module.exports = { startScheduler };
