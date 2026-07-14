'use strict';
/*
 * Email helper for verification + password-reset messages.
 *
 * Real sending uses SMTP via nodemailer when SMTP_HOST is configured. Without
 * it we run in SIMULATED mode: the email is logged to the console and the
 * action link is returned to the caller (dev only) so the flow can be completed
 * without a real inbox. In production (SMTP set) links are never returned.
 *
 * Hardening: the transport has explicit connection/socket timeouts so a slow or
 * unreachable SMTP server fails fast (≈10s) instead of hanging a web request.
 * Callers should not block a user response on the send — see server.js, which
 * fires verification/2FA/reset mails without awaiting them. At boot we run a
 * one-off transport.verify() and cache the result so /metrics can report whether
 * SMTP is actually reachable, without exposing credentials.
 */
const nodemailer = require('nodemailer');

const HOST = process.env.SMTP_HOST;
const LIVE = !!HOST;
const FROM = process.env.MAIL_FROM || 'Viomocoin <no-reply@viomocoin.app>';

// SMTP health, surfaced (as booleans only) via /metrics for remote diagnosis.
const health = { ready: null, error: null }; // ready: null=unknown, true=ok, false=failed

let transport = null;
if (LIVE) {
  transport = nodemailer.createTransport({
    host: HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    // Fail fast rather than hang a request if the server is unreachable.
    connectionTimeout: 10000, // ms to establish the TCP connection
    greetingTimeout: 10000,   // ms to wait for the SMTP greeting
    socketTimeout: 20000,     // ms of inactivity before giving up
  });
  // One-off connectivity probe so we can tell (remotely) whether SMTP works.
  transport.verify()
    .then(() => { health.ready = true; console.log('[mail] SMTP verified — ready to send.'); })
    .catch((e) => { health.ready = false; health.error = e.message; console.error('[mail] SMTP verify FAILED:', e.message); });
}

module.exports = {
  simulated: !LIVE,
  // Boolean-only health for /metrics (never exposes host/user/pass).
  get ready() { return health.ready; },
  get error() { return health.error; },
  async send(to, subject, { text, html }) {
    if (!LIVE) {
      console.log(`\n[mail:simulated] to=${to}\n  subject: ${subject}\n  ${text || ''}\n`);
      return { simulated: true };
    }
    const info = await transport.sendMail({ from: FROM, to, subject, text, html });
    return { simulated: false, id: info.messageId };
  },
};
