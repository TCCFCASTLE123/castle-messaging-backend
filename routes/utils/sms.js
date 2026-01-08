// utils/sms.js
const twilio = require('twilio');

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const twilioFrom = process.env.TWILIO_PHONE_NUMBER;

/**
 * Sends an SMS and logs it in the messages table.
 * @param {object} db - Your database connection
 * @param {string} phone - Destination phone number
 * @param {string} text - SMS body
 * @param {number|string} clientId - Client ID (FK)
 * @param {string} sender - Sender ('system' or 'me')
 * @param {function} cb - Callback(err, sid)
 */
function sendSmsAndLog(db, phone, text, clientId, sender = 'system', cb) {
  twilioClient.messages.create({
    body: text,
    from: twilioFrom,
    to: phone
  })
  .then(message => {
    db.run(
      "INSERT INTO messages (client_id, sender, text, direction, timestamp, external_id) VALUES (?, ?, ?, ?, ?, ?)",
      [clientId, sender, text, 'outbound', new Date().toISOString(), message.sid],
      err => {
        if (err) console.error("Failed to log SMS to DB:", err);
        if (cb) cb(err, message.sid);
      }
    );
  })
  .catch(err => {
    console.error('Twilio send failed:', err);
    if (cb) cb(err);
  });
}

module.exports = { sendSmsAndLog };
