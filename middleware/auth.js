// middleware/auth.js
const jwt = require("jsonwebtoken");

module.exports = function authMiddleware(req, res, next) {
  // ✅ Public routes
  // IMPORTANT: match your actual login route path
  if (
    req.path === "/api/auth/login" ||
    req.path === "/api/auth/register" || // if you have it
    req.path === "/health" ||
    req.path.startsWith("/api/twilio") ||
    req.path.startsWith("/twilio") || // keep if you mount twilio at root
    req.method === "OPTIONS"
  ) {
    return next();
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: "Missing auth token" });
  }
if (!user || user.is_active === 0) {
  return res.status(403).json({ error: "User inactive" });
}

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // support either { id } or { userId }
    req.userId = decoded.id ?? decoded.userId ?? null;

    if (!req.userId) {
      return res.status(401).json({ message: "Invalid token payload" });
    }

    return next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid/expired token" });
  }
};

