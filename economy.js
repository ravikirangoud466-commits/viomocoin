'use strict';
/*
 * Earnings model — kept deliberately simple:
 *
 *   All earnings come from AD REVENUE.
 *   Every time an ad plays on a monetized video it generates revenue, split
 *   three ways:
 *     • the creator keeps 70%          -> added to their balance
 *     • the viewer watching earns 10%  -> added to the viewer's balance (watch-to-earn)
 *     • the platform owner keeps 20%   -> added to the owner's account
 *
 *   Views, likes and watch-time are just engagement metrics — they do NOT mint
 *   coins. Coins are only (a) earned by creators from their ad-revenue share,
 *   (b) earned by viewers as a watch-to-earn reward, (c) received as tips /
 *   Super Chats, or (d) bought via wallet top-up.
 *
 *   Coins are simply a money unit: 1000 coins = $1.00, so 1 coin = $0.001.
 *   Creators cash out their balance in full — the platform's cut is already
 *   taken up front from ad revenue, so there is no separate withdrawal fee.
 */
const USD_TO_INR = Number(process.env.USD_TO_INR) || 83;         // approx FX for UPI payouts
const COMMISSION = Number(process.env.PLATFORM_COMMISSION_RATE); // e.g. 0.20 = 20%
const VIEWER_RATE = Number(process.env.VIEWER_REWARD_RATE);      // e.g. 0.10 = 10% to the watcher
const AD_REVENUE = Number(process.env.AD_REVENUE_COINS);         // total coins earned per ad view
const MON_SUBS = Number(process.env.MONETIZATION_MIN_SUBS);      // subscribers required to monetize
const MON_HOURS = Number(process.env.MONETIZATION_MIN_WATCH_HOURS); // watch hours required to monetize

module.exports = {
  COINS_PER_USD: 1000,           // 1000 coins = $1.00  (1 coin = $0.001)
  MIN_PAYOUT_COINS: 1000,        // must reach $1.00 to cash out
  AD_THROTTLE_MS: 30 * 60_000,   // one paid ad view per viewer per video / 30 min
  PLATFORM_COMMISSION_RATE: Number.isFinite(COMMISSION) ? COMMISSION : 0.20, // owner's 20% cut
  VIEWER_REWARD_RATE: Number.isFinite(VIEWER_RATE) ? VIEWER_RATE : 0.10,      // viewer's 10% watch-to-earn
  AD_REVENUE_COINS: Number.isFinite(AD_REVENUE) ? AD_REVENUE : 10, // $0.01 total per ad view
  USD_TO_INR,
  STRIKE_LIMIT: 3,               // strikes before a channel is auto-terminated
  AUTO_REMOVE_REPORTS: 5,        // distinct reporters that auto-remove a video + strike
  SIGNUP_BONUS: 100,             // welcome credit so new viewers can tip / super-chat
  SUPERCHAT_TIERS: [50, 100, 500, 1000, 5000], // coin amounts for super-chats / tips
  // Monetization eligibility (YouTube uses 1000 subs + 4000 watch hours; we use half
  // that — 500 subs + 2000 watch hours — so creators only start earning once they've
  // built a real audience, which is when real ad revenue can actually exist).
  MONETIZATION_MIN_SUBS: Number.isFinite(MON_SUBS) ? MON_SUBS : 500,
  MONETIZATION_MIN_WATCH_HOURS: Number.isFinite(MON_HOURS) ? MON_HOURS : 2000,

  coinsToCents(coins) {
    return Math.round((coins / this.COINS_PER_USD) * 100);
  },
  // Split one ad view's revenue three ways: creator 70%, viewer 10%, owner 20%.
  // The creator gets whatever is left after the owner and viewer shares, so the
  // parts always sum exactly to `total` regardless of rounding.
  adSplit() {
    const total = this.AD_REVENUE_COINS;
    const owner = Math.round(total * this.PLATFORM_COMMISSION_RATE);
    const viewer = Math.round(total * this.VIEWER_REWARD_RATE);
    return { total, owner, viewer, creator: total - owner - viewer };
  },
  // Convert USD cents -> INR paise (for UPI/Razorpay payouts).
  centsToPaise(cents) {
    return Math.round(cents * this.USD_TO_INR);
  },
};
