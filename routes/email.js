// email.js
const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'mayestelleslaw@gmail.com',
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

async function sendMail({ to, subject, text, html }) {
  const mailOptions = {
    from: '"Mayes Telles Law" <mayestelleslaw@gmail.com>',
    to,
    subject,
    text,
    ...(html && { html }),
  };

  try {
    let info = await transporter.sendMail(mailOptions);
    console.log('Email sent:', info.messageId);
    return info;
  } catch (err) {
    console.error('Error sending email:', err);
    throw err;
  }
}

module.exports = { sendMail };
