// middleware/auth.js

module.exports = function authMiddleware(req, res, next) {
  // Allow login & health checks
  if (
    req.path === "/login" ||
    req.path.startsWith("/twilio") ||
    req.method === "OPTIONS"
  ) {
    return next();
  }

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing auth token" });
  }

  const token = authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "Invalid auth token" });
  }

  // ✅ IMPORTANT — DO NOT HANG
  next();
};
