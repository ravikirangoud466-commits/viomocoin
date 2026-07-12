'use strict';
/*
 * Email helper for verification + password-reset messages.
 *
 * Real sending uses SMTP via nodemailer when SMTP_HOST is configured. Without
 * it we run in SIMULATED mode: the email is logged to the console and the
 * action link is returned to the caller (dev only) so the flow can be completed
 * without a real inbox. In production (SMTP set) links are never returned.
 */
const nodemailer = require('nodemailer');

const HOST = process.env.SMTP_HOST;
const LIVE = !!HOST;
const FROM = process.env.MAIL_FROM || 'Viomocoin <no-reply@viomocoin.app>';

let transport = null;
if (LIVE) {
  transport = nodemailer.createTransport({
    host: HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}

module.exports = {
  simulated: !LIVE,
  async send(to, subject, { text, html }) {
    if (!LIVE) {
      console.log(`\n[mail:simulated] to=${to}\n  subject: ${subject}\n  ${text || ''}\n`);
      return { simulated: true };
    }
    await transport.sendMail({ from: FROM, to, subject, text, html });
    return { simulated: false };
  },
};
