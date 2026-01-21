// lib/scheduler.js
// Polls scheduled_messages and sends due messages via Twilio,
// then records them into messages table so React shows them.

const db = require("../db");
const twilio = require("twilio");

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM_NUMBER = process.env.TWILIO_FROM;

const POLL_INTERVAL_MS = 15 * 1000; // 15s
const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 5;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendSMS({ to, body }) {
  const msg = await client.messages.create({
    from: FROM_NUMBER,
    to,
    body,
  });
  return msg.sid;
}

function startScheduler(io) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !FROM_NUMBER) {
    console.error("❌ Scheduler not started: missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM");
    return;
  }

  console.log("⏱️ Scheduler started (polling every", POLL_INTERVAL_MS, "ms)");

  // small delay so db migrations are done
  setTimeout(() => {
    setInterval(() => processQueue(io).catch((e) => console.error("❌ scheduler loop crashed:", e)), POLL_INTERVAL_MS);
    // also run immediately once
    processQueue(io).catch((e) => console.error("❌ scheduler initial run crashed:", e));
  }, 2000);
}

async function processQueue(io) {
  // IMPORTANT: use SQLite datetime() so comparisons work no matter how send_time is stored
  const rows = await new Promise((resolve, reject) => {
    db.all(
      `
      SELECT sm.*, c.phone
      FROM scheduled_messages sm
      JOIN clients c ON c.id = sm.client_id
      WHERE sm.status = 'pending'
        AND COALESCE(sm.attempts, 0) < ?
        AND datetime(sm.send_time) <= datetime('now')
      ORDER BY datetime(sm.send_time) ASC
      LIMIT ?
      `,
      [MAX_ATTEMPTS, BATCH_SIZE],
      (err, out) => {
        if (err) return reject(err);
        resolve(out || []);
      }
    );
  });

  if (!rows.length) return;

  for (const row of rows) {
    const to = `+1${String(row.phone || "").replace(/\D/g, "")}`;

    // mark sending + increment attempts
    await new Promise((resolve) => {
      db.run(
        `
        UPDATE scheduled_messages
        SET status='sending',
            attempts = COALESCE(attempts,0) + 1,
            updated_at=datetime('now')
        WHERE id=?
        `,
        [row.id],
        () => resolve()
      );
    });

    try {
      const sid = await sendSMS({ to, body: row.message });

      // mark sent
      await new Promise((resolve) => {
        db.run(
          `
          UPDATE scheduled_messages
          SET status='sent',
              sent_at=datetime('now'),
              updated_at=datetime('now'),
              error=NULL,
              last_error=NULL
          WHERE id=?
          `,
          [row.id],
          () => resolve()
        );
      });

      // store in messages so React shows it
      await new Promise((resolve) => {
        db.run(
          `
          INSERT INTO messages (client_id, sender, text, direction, external_id)
          VALUES (?, 'system', ?, 'outbound', ?)
          `,
          [row.client_id, row.message, sid],
          () => resolve()
        );
      });

      if (io) {
        io.emit("message_sent", {
          client_id: row.client_id,
          text: row.message,
          direction: "outbound",
          sender: "system",
        });
      }
    } catch (e) {
      const msg = e?.message || String(e);

      console.error("❌ Scheduler send failed:", msg);

      await new Promise((resolve) => {
        db.run(
          `
          UPDATE scheduled_messages
          SET status='failed',
              last_error=?,
              updated_at=datetime('now')
          WHERE id=?
          `,
          [msg, row.id],
          () => resolve()
        );
      });

      // tiny pause to avoid hammering Twilio if something is wrong
      await sleep(250);
    }
  }
}

module.exports = { startScheduler };
