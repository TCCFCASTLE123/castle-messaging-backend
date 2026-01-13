/*******************************************************
 * Castle Consulting Messaging Backend — UPDATED server.js
 * Backend: Node + Express + Socket.io + Twilio + SQLite
 *
 * ✅ Scheduled messages DISABLED
 * ✅ Sheets webhook enabled
 * ✅ Socket.io stable
 * ✅ Twilio inbound/outbound intact
 *******************************************************/

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const twilio = require("twilio");
const normalizePhone = require("./utils/normalizePhone");

// Routes
const authRoutes = require("./routes/auth");
const messageRoutes = require("./routes/messages");
const clientRoutes = require("./routes/clients");
const statusRoutes = require("./routes/statuses");
const templateRoutes = require("./routes/templates");
const scheduledMessagesRoutes = require("./routes/scheduledMEssages"); // left mounted, not active
const twilioRoutes = require("./routes/twilio");
const sheetsWebhookRoutes = require("./routes/sheetsWebhook");

// DB
const db = require("./db");

// -------------------- APP + SERVER --------------------
const app = express();
const server = http.createServer(app);

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
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
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

// -------------------- TWILIO SETUP --------------------
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const twilioFrom = process.env.TWILIO_PHONE_NUMBER;

// -------------------- API ROUTES --------------------
app.use("/api/auth", authRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/clients", clientRoutes);
app.use("/api/statuses", statusRoutes);
app.use("/api/templates", templateRoutes);
app.use("/api/scheduled_messages", scheduledMessagesRoutes); // routes still available
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

// =====================================================
// 🚫 SCHEDULED MESSAGE SENDER — DISABLED
// =====================================================
// Intentionally disabled while testing Sheets + live sync
// To re-enable later, we will restore cron.schedule()
// =====================================================

// -------------------- START SERVER --------------------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
