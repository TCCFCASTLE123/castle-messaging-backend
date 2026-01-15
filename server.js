/*******************************************************
 * Castle Consulting Messaging Backend — server.js
 * Node + Express + Socket.io + Twilio + SQLite
 *******************************************************/

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const twilio = require("twilio");

// Routes
const { router: authRoutes, requireAuth } = require("./routes/auth");
const messageRoutes = require("./routes/messages");
const clientRoutes = require("./routes/clients");
const statusRoutes = require("./routes/statuses");
const templateRoutes = require("./routes/templates");
const scheduledMessagesRoutes = require("./routes/scheduledMEssages");
const twilioRoutes = require("./routes/twilio");
const sheetsWebhookRoutes = require("./routes/sheetsWebhook");

// DB
const db = require("./db");

// -------------------- APP + SERVER --------------------
const app = express();
const server = http.createServer(app);

const jwt = require("jsonwebtoken");

    const token = h.slice("Bearer ".length).trim();
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Support either { id } or { userId } depending on how you signed the JWT
    req.user = {
      id: decoded.id ?? decoded.userId ?? decoded.user_id ?? null,
      username: decoded.username,
      role: decoded.role,
    };

    if (!req.user.id) {
      return res.status(401).json({ ok: false, error: "Invalid token payload" });
    }

    next();
   catch (e) {
    return res.status(401).json({ ok: false, error: "Invalid token" });
  }
}


// -------------------- LOGGING --------------------
app.use((req, res, next) => {
  console.log("➡️", req.method, req.url);
  next();
});

// -------------------- CORS --------------------
const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:5000",
  "https://castle-consulting-firm-messaging.onrender.com",
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("CORS blocked origin: " + origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-api-key", "x-webhook-key"],
  })
);

// Preflight
app.options(/.*/, cors());

// -------------------- BODY PARSERS --------------------
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// -------------------- SOCKET.IO --------------------
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Make io available to routes
app.use((req, res, next) => {
  req.io = io;
  next();
});

// -------------------- SAFE AUTO-MIGRATIONS --------------------
function ensureClientColumns() {
  db.all("PRAGMA table_info(clients)", [], (err, cols) => {
    if (err) return console.error("❌ PRAGMA clients failed:", err.message);

    const names = new Set((cols || []).map((c) => c.name));

    const addCol = (name, type) => {
      if (names.has(name)) return;
      db.run(`ALTER TABLE clients ADD COLUMN ${name} ${type}`, [], (e) => {
        if (e) console.error(`❌ ADD COLUMN clients.${name} failed:`, e.message);
        else console.log(`✅ Added clients.${name}`);
      });
    };

    // fields we want from Google Sheets
    addCol("status_text", "TEXT");
    addCol("case_group", "TEXT");
    addCol("appt_setter", "TEXT");
    addCol("ic", "TEXT");
  });
}
ensureClientColumns();

// -------------------- TWILIO SETUP --------------------
twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// -------------------- API ROUTES --------------------
app.use("/api/auth", authRoutes);
app.use("/api/messages", requireAuth, messageRoutes);
app.use("/api/clients", clientRoutes);
app.use("/api/statuses", statusRoutes);
app.use("/api/templates", templateRoutes);
app.use("/api/scheduled_messages", scheduledMessagesRoutes);
app.use("/api/twilio", twilioRoutes);
app.use("/api/sheets", sheetsWebhookRoutes);

// -------------------- HOME --------------------
app.get("/", (req, res) => {
  res.send("Castle Consulting Messaging API is running!");
});

// -------------------- SOCKET.IO EVENTS --------------------
io.on("connection", (socket) => {
  console.log("Socket.IO user connected:", socket.id);
});

// -------------------- START SERVER --------------------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});






