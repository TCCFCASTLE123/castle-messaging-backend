/*******************************************************
 * Castle Consulting Messaging Backend — CLEAN + COMPLETE server.js
 * ✅ Uses route-file approach for Twilio (routes/twilio.js)
 * ✅ Supports React realtime via Socket.io (req.io)
 * ✅ Supports Twilio inbound webhooks (x-www-form-urlencoded)
 * ✅ Keeps your CRON scheduled sender
 * ✅ Removes duplicate inline inbound webhook (no conflicts)
 *******************************************************/

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const cron = require('node-cron');
const twilio = require('twilio');
const normalizePhone = require('./utils/normalizePhone');

// Route imports
const authRoutes = require('./routes/auth');
const messageRoutes = require('./routes/messages');
const clientRoutes = require('./routes/clients');
const statusRoutes = require('./routes/statuses');
const templateRoutes = require('./routes/templates');
const scheduledMessagesRoutes = require('./routes/scheduledMEssages'); // your existing filename
const twilioRoutes = require('./routes/twilio'); // ✅ NEW

// DB
const db = require('./db');

// -------------------- TWILIO SETUP (used by CRON sender) --------------------
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const twilioFrom = process.env.TWILIO_PHONE_NUMBER;

// Outbound SMS helper (used by CRON)
function sendSms(phone, text, callback) {
  const normPhone = normalizePhone(phone);
  if (!normPhone) return callback && callback(new Error('Invalid phone number'));

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

import cors from "cors"; // or require("cors")

const allowedOrigins = [
  "http://localhost:3000", // keep for local dev
  "https://castle-consulting-firm-messaging.onrender.com",
];

app.use(cors({
  origin: function (origin, callback) {
    // allow non-browser requests (Twilio, GAS, server-to-server)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("CORS blocked origin: " + origin));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

const app = express();
const server = http.createServer(app);

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));

// IMPORTANT:
// - React/API uses JSON
// - Twilio webhooks use x-www-form-urlencoded
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // ✅ REQUIRED for Twilio inbound

// -------------------- SOCKET.IO SETUP --------------------
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
  },
});

app.use((req, res, next) => {
  req.io = io; // ✅ lets route files emit realtime events
  next();
});

// -------------------- API ROUTES --------------------
app.use('/api/auth', authRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/statuses', statusRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/scheduled_messages', scheduledMessagesRoutes);

// ✅ Twilio routes (send + inbound) — SEE routes/twilio.js
app.use('/api/twilio', twilioRoutes);

// -------------------- HOME --------------------
app.get('/', (req, res) => {
  res.send('Castle Consulting Messaging API is running!');
});

// -------------------- SOCKET.IO EVENTS --------------------
io.on('connection', (socket) => {
  console.log('Socket.IO user connected:', socket.id);
});

// =====================================================
// --- SCHEDULED MESSAGE SENDER (runs every minute) ---
// =====================================================
cron.schedule('* * * * *', () => {
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

      console.log("== CRON JOB FIRING ==", rows.length, "scheduled messages to send");

      rows.forEach((msg) => {
        const normPhone = normalizePhone(msg.phone);
        if (!normPhone) {
          console.warn("Scheduled message missing/invalid client phone for client_id:", msg.client_id);
          return;
        }

        console.log("About to send scheduled SMS for client_id:", msg.client_id, "text:", msg.text);

        sendSms(normPhone, msg.text, (twilioErr, sid) => {
          const ts = new Date().toISOString();

          // Save outbound message (so it shows in React)
          db.run(
            "INSERT INTO messages (client_id, sender, text, direction, timestamp) VALUES (?, ?, ?, ?, ?)",
            [msg.client_id, 'system', msg.text, 'outbound', ts],
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
                    console.error("Failed to update scheduled_messages as sent:", updateErr);
                  }
                }
              );

              // Emit to React realtime
              io.emit('message', {
                client_id: msg.client_id,
                sender: 'system',
                text: msg.text,
                direction: 'outbound',
                timestamp: ts,
                twilio_sid: sid || null,
              });

              console.log("Scheduled message inserted to messages table! RowID:", this.lastID);
            }
          );

          if (twilioErr) {
            console.error("Failed to send scheduled SMS:", twilioErr);
          } else {
            console.log("Scheduled SMS sent and saved to DB. SID:", sid);
          }
        });
      });
    }
  );
});

// -------------------- SERVER LISTEN --------------------
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});


