'use strict';
/*
 * UPI payouts for Indian creators — pay any UPI ID (PhonePe @ybl, Google Pay
 * @okhdfcbank, Paytm @paytm, BHIM, etc.). A single UPI ID (VPA) works across
 * every UPI app, so collecting one VPA covers "all UPI methods".
 *
 * Real payouts use Razorpay Payouts (RazorpayX): create a contact -> a VPA
 * fund account -> a payout. If the Razorpay env vars aren't set, we run in
 * SIMULATED mode so the whole flow works without credentials.
 *
 * Required env for real mode:
 *   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_ACCOUNT_NUMBER (RazorpayX virtual a/c)
 */
const crypto = require('node:crypto');
const KEY_ID = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const ACCOUNT_NUMBER = process.env.RAZORPAY_ACCOUNT_NUMBER;
const LIVE = !!(KEY_ID && KEY_SECRET && ACCOUNT_NUMBER);
const BASE = 'https://api.razorpay.com/v1';

const VPA_RE = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/;

function authHeader() {
  return 'Basic ' + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');
}
async function rzp(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.description || 'Razorpay error');
  return data;
}

module.exports = {
  enabled: LIVE,
  webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  validVpa: (v) => VPA_RE.test(String(v || '').trim()),

  /** Verify a Razorpay webhook's X-Razorpay-Signature (HMAC-SHA256 of the raw body). */
  verifyWebhook(rawBody, signature) {
    if (!this.webhookSecret || !signature) return false;
    const expected = crypto.createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));
    } catch { return false; }
  },

  /**
   * Send `paise` (INR minor units) to a UPI id.
   * Returns { simulated, id, status }.
   */
  async payout(user, vpa, paise, note) {
    if (!LIVE) {
      return { simulated: true, id: 'pout_sim_' + Date.now(), status: 'processing' };
    }
    const contact = await rzp('/contacts', {
      name: user.channel_name, email: user.email, type: 'vendor',
      reference_id: 'user_' + user.id,
    });
    const fund = await rzp('/fund_accounts', {
      contact_id: contact.id, account_type: 'vpa', vpa: { address: vpa },
    });
    const payout = await rzp('/payouts', {
      account_number: ACCOUNT_NUMBER,
      fund_account_id: fund.id,
      amount: paise, currency: 'INR', mode: 'UPI',
      purpose: 'payout', queue_if_low_balance: true,
      narration: (note || 'Viomocoin payout').slice(0, 30),
    });
    return { simulated: false, id: payout.id, status: payout.status };
  },
};
