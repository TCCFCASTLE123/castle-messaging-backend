module.exports = function normalizePhone(input) {
  if (!input) return "";

  // strip everything except digits
  const digits = String(input).replace(/\D/g, "");

  // allow 10-digit US numbers
  if (digits.length === 10) return `+1${digits}`;

  // allow 11-digit starting with 1
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  return ""; // invalid
};
