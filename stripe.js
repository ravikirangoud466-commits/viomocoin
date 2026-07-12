'use strict';
/*
 * Stripe Connect helper.
 *
 * Real payouts to creators use Stripe Connect Express accounts:
 *   1. Creator onboards -> we create a connected account + onboarding link.
 *   2. On cash-out we create a Transfer from the platform balance to that account.
 *
 * If STRIPE_SECRET_KEY is not set, we run in SIMULATED mode so the whole app
 * still works end-to-end without real credentials. Drop a real test/live key in
 * .env to switch to genuine Stripe calls — no other code changes required.
 */
const KEY = process.env.STRIPE_SECRET_KEY;
const LIVE = !!KEY;
let stripe = null;
if (LIVE) stripe = require('stripe')(KEY);

const BASE_URL = process.env.BASE_URL || 'http://localhost:5178';

module.exports = {
  enabled: LIVE,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',

  /** Verify + parse a Stripe webhook. Throws if the signature is invalid. */
  constructEvent(rawBody, signature) {
    if (!stripe) throw new Error('Stripe not configured');
    return stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
  },

  /** Create (or reuse) a connected Express account and return an onboarding URL. */
  async createOnboarding(user) {
    if (!LIVE) {
      // Simulated: pretend the account is instantly connected.
      return { simulated: true, accountId: 'acct_sim_' + user.id, url: null };
    }
    let accountId = user.stripe_account_id;
    if (!accountId) {
      const acct = await stripe.accounts.create({
        type: 'express',
        email: user.email,
        capabilities: { transfers: { requested: true } },
        business_profile: { product_description: 'Viomocoin creator payouts' },
      });
      accountId = acct.id;
    }
    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${BASE_URL}/#studio`,
      return_url: `${BASE_URL}/#studio`,
      type: 'account_onboarding',
    });
    return { simulated: false, accountId, url: link.url };
  },

  /** Whether a connected account has completed onboarding and can receive transfers. */
  async payoutsReady(accountId) {
    if (!LIVE) return true;
    if (!accountId) return false;
    const acct = await stripe.accounts.retrieve(accountId);
    return !!acct.payouts_enabled;
  },

  /** Transfer USD (in cents) to the creator's connected account. */
  async transfer(accountId, cents, meta) {
    if (!LIVE) {
      return { simulated: true, id: 'tr_sim_' + Date.now() };
    }
    const tr = await stripe.transfers.create({
      amount: cents,
      currency: 'usd',
      destination: accountId,
      metadata: meta || {},
    });
    return { simulated: false, id: tr.id };
  },
};
