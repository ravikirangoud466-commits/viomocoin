'use strict';
/*
 * PayPal Payouts — pay creators anywhere in the world by their PayPal email.
 *
 * Real payouts use the PayPal Payouts API (a batch with one item per creator).
 * If PAYPAL_CLIENT_ID / PAYPAL_SECRET aren't set we run in SIMULATED mode so the
 * whole flow works without credentials.
 *
 * Required env for real mode:
 *   PAYPAL_CLIENT_ID, PAYPAL_SECRET
 * Optional:
 *   PAYPAL_ENV = 'live' | 'sandbox' (default 'sandbox')
 *   PAYPAL_WEBHOOK_ID  — enables webhook signature verification
 */
const CLIENT = process.env.PAYPAL_CLIENT_ID;
const SECRET = process.env.PAYPAL_SECRET;
const LIVE = !!(CLIENT && SECRET);
const ENV = (process.env.PAYPAL_ENV || 'sandbox').toLowerCase();
const BASE = ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Cache the OAuth token until shortly before it expires.
let cachedToken = null, tokenExp = 0;
async function token() {
  if (cachedToken && Date.now() < tokenExp) return cachedToken;
  const res = await fetch(BASE + '/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${CLIENT}:${SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const d = await res.json();
  if (!res.ok) throw new Error(d.error_description || 'PayPal auth failed');
  cachedToken = d.access_token;
  tokenExp = Date.now() + Math.max(0, (d.expires_in - 60)) * 1000;
  return cachedToken;
}

module.exports = {
  enabled: LIVE,
  env: ENV,
  webhookId: process.env.PAYPAL_WEBHOOK_ID || '',
  validEmail: (e) => EMAIL_RE.test(String(e || '').trim()),

  /** Send `cents` USD to a creator's PayPal email. Returns { simulated, id, status }. */
  async payout(user, email, cents, note) {
    if (!LIVE) {
      return { simulated: true, id: 'pp_sim_' + Date.now(), status: 'PENDING' };
    }
    const t = await token();
    const value = (cents / 100).toFixed(2);
    const body = {
      sender_batch_header: {
        sender_batch_id: 'vmc_' + user.id + '_' + Date.now(),
        email_subject: 'You have a Viomocoin payout',
        email_message: 'Your Viomocoin creator earnings have been sent.',
      },
      items: [{
        recipient_type: 'EMAIL',
        amount: { value, currency: 'USD' },
        receiver: String(email).trim(),
        note: (note || 'Viomocoin creator payout').slice(0, 90),
        sender_item_id: 'user_' + user.id + '_' + Date.now(),
      }],
    };
    const res = await fetch(BASE + '/v1/payments/payouts', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.message || d.name || 'PayPal payout failed');
    return { simulated: false, id: d.batch_header.payout_batch_id, status: d.batch_header.batch_status };
  },

  /**
   * Verify a PayPal webhook using PayPal's verify-webhook-signature API.
   * Needs PAYPAL_WEBHOOK_ID. Returns true only on a SUCCESS verification.
   */
  async verifyWebhook(headers, rawBody) {
    if (!LIVE || !this.webhookId) return false;
    try {
      const t = await token();
      const res = await fetch(BASE + '/v1/notifications/verify-webhook-signature', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transmission_id: headers['paypal-transmission-id'],
          transmission_time: headers['paypal-transmission-time'],
          cert_url: headers['paypal-cert-url'],
          auth_algo: headers['paypal-auth-algo'],
          transmission_sig: headers['paypal-transmission-sig'],
          webhook_id: this.webhookId,
          webhook_event: JSON.parse(rawBody.toString()),
        }),
      });
      const d = await res.json();
      return d.verification_status === 'SUCCESS';
    } catch { return false; }
  },
};
