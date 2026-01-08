function normalizePhone(phone) {
  // Remove all non-digit characters except leading +
  if (!phone) return "";
  let normalized = phone.replace(/[^\d+]/g, "");
  // Ensure + is at the start
  if (normalized.startsWith("1") && !normalized.startsWith("+")) {
    normalized = "+" + normalized;
  }
  if (!normalized.startsWith("+")) {
    normalized = "+" + normalized;
  }
  return normalized;
}

module.exports = normalizePhone;
