// lib/scheduler.js
// Background worker that sends due scheduled_messages.
// - Finds pending messages whose send_time <= now
// - Marks them sending (to avoid double-send)
// - Sends via internal send-sms route (so it SAVES to DB + shows in React)
// - Marks sent/failed, increments attempts

const db = require("../db");

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Convert SQLite datetime('now') strings or ISO strings into ms reliably enough
function isDue(send_time) {
  if (!send_time) return false;
  const t = new Date(send_time).getTime();
  if (!Number.isFinite(t)) return false;
  return t <= Date.now();
}

// Small helper: run db.get/db.all/db.run as promises
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

// Mark one job "sending" if still pending.
// This is our lock to prevent double sends if multiple instances run.
async function claimJob(id) {
  const r = await dbRun(
    `
      UPDATE scheduled_messages
      SET status='sending',
          updated_at=datetime('now')
      WHERE id = ? AND status='pending'
    `,
    [id]
  );
  return r.changes === 1;
}

async function markSent(id) {
  await dbRun(
    `
      UPDATE scheduled_messages
      SET status='sent',
          sent_at=datetime('now'),
          error=NULL,
          last_error=NULL,
          updated_at=datetime('now')
      WHERE id = ?
    `,
    [id]
  );
}

async function markFailed(id, errMsg) {
  const msg = String(errMsg || "Unknown error").slice(0, 2000);
  await dbRun(
    `
      UPDATE scheduled_messages
      SET status='failed',
          attempts = COALESCE(attempts,0) + 1,
          last_error = ?,
          error = ?,
          updated_at=datetime('now')
      WHERE id = ?
    `,
    [msg, msg, id]
  );
}

// Optional: if you want retries, flip failed back to pending after X minutes
async function requeueFailures(maxAttempts = 5, retryAfterMinutes = 15) {
  await dbRun(
    `
      UPDATE scheduled_messages
      SET status='pending',
          updated_at=datetime('now')
      WHERE status='failed'
        AND COALESCE(attempts,0) < ?
        AND (
          updated_at IS NULL OR
          datetime(updated_at) <= datetime('now', ?)
        )
    `,
    [maxAttempts, `-${retryAfterMinutes} minutes`]
  );
}

// Core loop
function startScheduler({ sendFn, intervalMs = 5000, batchSize = 25, log = console } = {}) {
  if (typeof sendFn !== "function") {
    throw new Error("startScheduler requires sendFn({client_id, to, text})");
  }

  let stopped = false;
  let running = false;

  async function tick() {
    if (stopped || running) return;
    running = true;

    try {
      // Retry policy: requeue older failures
      await requeueFailures(5, 15);

      // Pull a small batch of candidates
      const rows = await dbAll(
        `
          SELECT sm.id, sm.client_id, sm.send_time, sm.message, c.phone
          FROM scheduled_messages sm
          JOIN clients c ON c.id = sm.client_id
          WHERE sm.status='pending'
          ORDER BY datetime(sm.send_time) ASC
          LIMIT ?
        `,
        [batchSize]
      );

      for (const job of rows) {
        if (stopped) break;

        // Defensive: if send_time is not parseable/valid, fail it
        if (!isDue(job.send_time)) continue;

        const claimed = await claimJob(job.id);
        if (!claimed) continue;

        try {
          await sendFn({
            client_id: job.client_id,
            to: job.phone,
            text: job.message,
          });
          await markSent(job.id);
          log.log?.(`✅ Scheduled SMS sent id=${job.id} client_id=${job.client_id}`);
        } catch (e) {
          await markFailed(job.id, e?.message || String(e));
          log.error?.(`❌ Scheduled SMS failed id=${job.id}:`, e?.message || e);
        }
      }
    } catch (e) {
      log.error?.("❌ Scheduler tick crashed:", e?.message || e);
    } finally {
      running = false;
    }
  }

  // Kick off interval
  const timer = setInterval(tick, intervalMs);

  // Run immediately once
  tick().catch(() => {});

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

module.exports = { startScheduler };
