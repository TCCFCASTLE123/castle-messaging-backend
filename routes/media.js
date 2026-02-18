// routes/media.js
const express = require("express");
const router = express.Router();
const axios = require("axios");

router.get("/:encodedUrl", async (req, res) => {
  try {
    const mediaUrl = Buffer.from(req.params.encodedUrl, "base64").toString("utf8");

    if (!mediaUrl.startsWith("https://api.twilio.com")) {
      return res.status(400).send("Invalid media URL");
    }

    const response = await axios.get(mediaUrl, {
      responseType: "arraybuffer",
      auth: {
        username: process.env.TWILIO_ACCOUNT_SID,
        password: process.env.TWILIO_AUTH_TOKEN,
      },
    });

    res.set("Content-Type", response.headers["content-type"]);
    res.set(
      "Content-Disposition",
      `attachment; filename="attachment"`
    );

    res.send(response.data);
  } catch (err) {
    console.error("❌ Media proxy failed:", err.message);
    res.status(500).send("Media download failed");
  }
});

module.exports = router;
