/**
 * Phone normalization utilities
 *
 * Canonical DB format: 10-digit US number (XXXXXXXXXX)
 * Twilio format: E.164 (+1XXXXXXXXXX)
 */

// --------------------
// Normalize for DB
// --------------------
function normalizeForDb(input) {
  if (!input) return "";

  const digits = String(input).replace(/\D/g, "");

  // Strip leading country code
  if (digits.length === 11 && digits.startsWith("1")) {
    return digits.slice(1);
  }

  // Valid US number
  if (digits.length === 10) {
    return digits;
  }

  return "";
}

// --------------------
// Normalize for Twilio
// --------------------
function normalizeForTwilio(input) {
  const dbPhone = normalizeForDb(input);
  if (!dbPhone) return "";
  return `+1${dbPhone}`;
}

module.exports = {
  normalizeForDb,
  normalizeForTwilio,
};
