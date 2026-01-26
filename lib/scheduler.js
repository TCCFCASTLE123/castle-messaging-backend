// lib/scheduler.js

const db = require("../db");
const twilio = require("twilio");

const POLL_INTERVAL_MS = 15_000;
const MAX_ATTEMPTS = 5;

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM,
} = process.env;

let twilioClient = null;

if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

function startScheduler(io) {
  if (!twilioClient || !TWILIO_FROM) {
    console.error("❌ Scheduler NOT started — missing Twilio env vars");
    return;
  }

  console.log("🕒 Scheduler started — polling every 15s");

  setInterval(() => {
    tick(io).catch((err) =>
      console.error("❌ Scheduler tick crashed:", err)
    );
  }, POLL_INTERVAL_MS);
}

async function tick(io) {
  const now = Date.now();
  console.log("⏱️ Scheduler tick @", new Date(now).toISOString());

  const rows = await all(
    `
    SELECT sm.*, c.phone
    FROM scheduled_messages sm
    JOIN clients c ON c.id = sm.client_id
    WHERE sm.status = 'pending'
      AND sm.send_time <= ?
      AND sm.attempts < ?
    ORDER BY sm.send_time ASC
    LIMIT 10
    `,
    [now, MAX_ATTEMPTS]
  );

  console.log("📬 Due messages found:", rows.length);

  for (const row of rows) {
    await processRow(row, io);
  }
}

async function processRow(row, io) {
  const to = formatE164(row.phone);

  await run(
    `
    UPDATE scheduled_messages
    SET status='sending',
        attempts = attempts + 1,
        updated_at = ?
    WHERE id = ?
    `,
    [Date.now(), row.id]
  );

  try {
    const msg = await twilioClient.messages.create({
      from: TWILIO_FROM,
      to,
      body: row.message,
    });

    await run(
      `
      UPDATE scheduled_messages
      SET status='sent',
          sent_at = ?,
          updated_at = ?
      WHERE id = ?
      `,
      [Date.now(), Date.now(), row.id]
    );

    await run(
      `
      INSERT INTO messages (client_id, sender, text, direction, external_id)
      VALUES (?, 'system', ?, 'outbound', ?)
      `,
      [row.client_id, row.message, msg.sid]
    );

    io?.emit("message_sent", {
      client_id: row.client_id,
      text: row.message,
      direction: "outbound",
    });

    console.log("✅ Scheduled SMS sent:", row.id);
  } catch (err) {
    await run(
      `
      UPDATE scheduled_messages
      SET status='failed',
          last_error=?,
          updated_at=?
      WHERE id=?
      `,
      [err.message, Date.now(), row.id]
    );

    console.error("❌ Scheduled SMS failed:", row.id, err.message);
  }
}

// ---------------- helpers ----------------

function formatE164(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return "";
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err) => (err ? reject(err) : resolve()));
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) =>
      err ? reject(err) : resolve(rows || [])
    );
  });
}

module.exports = { startScheduler };
