/*******************************************************
 * Castle Consulting Messaging Backend — server.js
 *******************************************************/

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

// Routes
const { router: authRoutes, requireAuth } = require("./routes/auth");
const messageRoutes = require("./routes/messages");
const clientRoutes = require("./routes/clients");
const statusRoutes = require("./routes/statuses");
const templateRoutes = require("./routes/templates");
const scheduledMessagesRoutes = require("./routes/scheduledMEssages");
const twilioRoutes = require("./routes/twilio");
const sheetsWebhookRoutes = require("./routes/sheetsWebhook");
const internalRoutes = require("./routes/internal");

// Scheduler
const { startScheduler } = require("./lib/scheduler");

// DB
require("./db");

// -------------------- APP --------------------
const app = express();
const server = http.createServer(app);

// -------------------- LOGGING --------------------
app.use((req, res, next) => {
  console.log("➡️", req.method, req.url);
  next();
});

// -------------------- CORS (SAFE FOR NODE 22) --------------------
const allowedOrigins = [
  "http://localhost:3000",
  "https://castle-consulting-firm-messaging.onrender.com",
];

const corsMiddleware = cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("CORS blocked origin: " + origin));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "x-api-key",
    "x-webhook-key",
  ],
});

// 🔥 CORS must run BEFORE auth
app.use(corsMiddleware);

// 🔥 SAFELY short-circuit preflight WITHOUT routes
app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

// -------------------- BODY PARSER --------------------
app.use(express.json());

// -------------------- SOCKET.IO --------------------
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "PATCH"],
    credentials: true,
  },
});

io.on("connection", (socket) => {
  console.log("🔌 Socket connected:", socket.id);
});

// -------------------- START SCHEDULER --------------------
startScheduler(io);

// -------------------- ROUTES --------------------
app.use("/api/auth", authRoutes);

app.use("/api/messages", requireAuth, messageRoutes);
app.use("/api/clients", requireAuth, clientRoutes);
app.use("/api/statuses", requireAuth, statusRoutes);
app.use("/api/templates", requireAuth, templateRoutes);
app.use("/api/scheduled_messages", requireAuth, scheduledMessagesRoutes);

app.use("/api/twilio", twilioRoutes);
app.use("/api/sheets", sheetsWebhookRoutes);
app.use("/api/internal", internalRoutes);

// -------------------- HOME --------------------
app.get("/", (req, res) => {
  res.send("Castle Consulting Messaging API is running!");
});

// -------------------- LISTEN --------------------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
