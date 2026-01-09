/*******************************************************
 * Castle Consulting Messaging Backend — FULL server.js
 * Backend: Node + Express + Socket.io + Twilio + Cron + SQLite
 *
 * ✅ CORS fixed for Render frontend + localhost
 * ✅ Preflight OPTIONS fixed (no more Network Error)
 * ✅ Twilio inbound support (x-www-form-urlencoded)
 * ✅ Routes mounted under /api/*
 * ✅ req.io available inside route files
 * ✅ Keeps scheduled sender CRON
 *******************************************************/

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const cron = require("node-cron");
const twilio = require("twilio");
const normalizePhone = require("./utils/normalizePhone");

// Routes
const authRoutes = require("./routes/auth");
const messageRoutes = require("./routes/messages");
const clientRoutes = require("./routes/clients");
const statusRoutes = require("./routes/statuses");
const templateRoutes = require("./routes/templates");
const scheduledMessagesRoutes = require("./routes/scheduledMEssages"); // keep your existing filename
const twilioRoutes = require("./routes/twilio");

// DB
const db = require("./db");

// -------------------- APP + SERVER --------------------
const app = express();
const server = http.createServer(app);

// -------------------- CORS --------------------
// 🔥 PUT YOUR FRONTEND URL HERE (this is what fixes your error)
const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:5000", // optional, harmless
  "https://castle-consulting-firm-messaging.onrender.com",
];

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow non-browser requests (Twilio, GAS, Postman) that have no Origin header
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) return callback(null, true);

      return callback(new Error("CORS blocked origin: " + origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ✅ Fixes preflight OPTIONS issue
app.options(/.*/, cors());

// -------------------- BODY PARSERS --------------------
// React/API uses JSON
app.use(express.json());

// Twilio webhooks use x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

// -------------------- SOCKET.IO --------------------
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Make io available in route files: req.io.emit(...)
app.use((req, res, next) => {
  req.io = io;
  next();
});

// -------------------- TWILIO SETUP (used by CRON sender) --------------------
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const twilioFrom = process.env.TWILIO_PHONE_NUMBER;

// Outbound SMS helper (used by CRON)
function sendSms(phone, text, callback) {
  const normPhone = normalizePhone(phone);
  if (!normPhone) return callback && callback(new Error("Invalid phone number"));

  twilioClient.messages
    .create({
      body: text,
      from: twilioFrom,
      to: normPhone,
    })
    .then((message) => {
      console.log("Twilio sent message:", message.sid);
      if (callback) callback(null, message.sid);
    })
    .catch((error) => {
      console.error("Twilio send failed:", error);
      if (callback) callback(error);
    });
}

// -------------------- API ROUTES --------------------
app.use("/api/auth", authRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/clients", clientRoutes);
app.use("/api/statuses", statusRoutes);
app.use("/api/templates", templateRoutes);
app.use("/api/scheduled_messages", scheduledMessagesRoutes);
app.use("/api/twilio", twilioRoutes);

// -------------------- HOME --------------------
app.get("/", (req, res) => {
  res.send("Castle Consulting Messaging API is running!");
});

// -------------------- SOCKET.IO EVENTS --------------------
io.on("connection", (socket) => {
  console.log("Socket.IO user connected:", socket.id);
});

// =====================================================
// --- SCHEDULED MESSAGE SENDER (runs every minute) ---
// =====================================================
cron.schedule("* * * * *", () => {
  const now = Date.now();

  db.all(
    `SELECT sm.*, c.phone 
     FROM scheduled_messages sm 
     LEFT JOIN clients c ON sm.client_id = c.id 
     WHERE sm.send_time <= ? AND (sm.sent IS NULL OR sm.sent = 0)`,
    [now],
    (err, rows) => {
      if (err) {
        console.error("Scheduled message check failed:", err);
        return;
      }

      if (!rows.length) {
        console.log("== CRON JOB FIRING == No scheduled messages to send");
        return;
      }

      console.log(
        "== CRON JOB FIRING ==",
        rows.length,
        "scheduled messages to send"
      );

      rows.forEach((msg) => {
        const normPhone = normalizePhone(msg.phone);
        if (!normPhone) {
          console.warn(
            "Scheduled message missing/invalid client phone for client_id:",
            msg.client_id
          );
          return;
        }

        console.log(
          "About to send scheduled SMS for client_id:",
          msg.client_id,
          "text:",
          msg.text
        );

        sendSms(normPhone, msg.text, (twilioErr, sid) => {
          const ts = new Date().toISOString();

          if (twilioErr) {
            console.error(
              "Scheduled message Twilio send failed for scheduled_messages.id:",
              msg.id,
              twilioErr
            );
            // (optional) you could mark it failed in DB here
            return;
          }

          // Save outbound message (so it shows in React)
          db.run(
            "INSERT INTO messages (client_id, sender, text, direction, timestamp) VALUES (?, ?, ?, ?, ?)",
            [msg.client_id, "system", msg.text, "outbound", ts],
            function (insertErr) {
              if (insertErr) {
                console.error("Scheduled message DB insert failed:", insertErr);
                return;
              }

              // Mark scheduled message sent
              db.run(
                "UPDATE scheduled_messages SET sent = 1 WHERE id = ?",
                [msg.id],
                (updateErr) => {
                  if (updateErr) {
                    console.error(
                      "Failed to update scheduled_messages as sent:",
                      updateErr
                    );
                  }
                }
              );

              // Emit to React realtime
              io.emit("message", {
                client_id: msg.client_id,
                sender: "system",
                text: msg.text,
                direction: "outbound",
                timestamp: ts,
                twilio_sid: sid || null,
              });

              console.log(
                "Scheduled message inserted to messages table! RowID:",
                this.lastID
              );
            }
          );
        });
      });
    }
  );
});

// -------------------- START SERVER --------------------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});


