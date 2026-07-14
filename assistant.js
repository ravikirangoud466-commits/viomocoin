'use strict';
/*
 * "Viomo AI" — an in-app help assistant for creators.
 *
 * Two modes, chosen automatically:
 *   - LIVE: when ANTHROPIC_API_KEY is set, questions are answered by Claude,
 *     grounded in the Viomocoin knowledge base below (raw HTTPS via fetch — no
 *     SDK dependency, matching the other adapters in this project).
 *   - FAQ: with no key, a built-in keyword matcher answers the common questions
 *     for free. So the widget works the moment it ships; add a key to upgrade.
 *
 * Model defaults to claude-opus-4-8; override with ANTHROPIC_MODEL (e.g.
 * claude-haiku-4-5 for a cheaper support bot).
 */
const KEY = process.env.ANTHROPIC_API_KEY;
const LIVE = !!KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';

// Facts about the platform. Used as the system prompt (LIVE) and mirrored by the
// FAQ answers (fallback), so both modes stay accurate and on-brand.
const KB = `You are "Viomo AI", the friendly in-app help assistant for Viomocoin — a YouTube-style video platform where creators upload videos and EARN from ad revenue, with the tagline "Watch. Upload. Earn."

Answer creators' questions about using Viomocoin. Be concise, warm, and practical (2-6 sentences, use a short list when it helps). Only answer about Viomocoin and general creator/video topics. If you don't know something specific to this user's account, say so and suggest they check Creator Studio or contact support — never invent features, numbers, or policies.

KEY FACTS:
- EARNINGS: Creators earn a share of ad revenue on their videos once they are monetized. The split is: the creator keeps 70%, the viewer watching earns 10% (watch-to-earn), and the platform keeps 20%. Earnings show up as coins as you grow; real ad revenue is what funds actual payouts.
- COINS: The currency is coins. 1000 coins = $1.00. New users get a 100-coin welcome bonus.
- MONETIZATION: To turn on ad monetization, a creator needs about 500 subscribers AND 2000 watch hours (about half of YouTube's bar), must pass identity verification (KYC), then click "Enable monetization" in Creator Studio. Before reaching that, the platform keeps the ad revenue. This bar exists because payouts are funded by the real ad revenue that an audience generates.
- PAYOUTS: Once monetized, creators cash out from Creator Studio via PayPal (worldwide, in $), UPI (India, in ₹), or Stripe (bank). Minimum payout is 1000 coins ($1), no withdrawal fee, and identity verification (KYC) is required first. Withdrawals are backed by real collected ad revenue, so as the platform grows its audience and ad income, payouts unlock. Be honest that Viomocoin is early — never promise instant or guaranteed day-one cash withdrawals.
- UPLOADING: Use the Upload button. You can add a custom thumbnail, tags/#hashtags, set visibility (public / unlisted / private), schedule publishing, mark a video as a Short, make it members-only, add captions, schedule a Premiere, and add cards + an end screen.
- TOOLS: Creators also have channel memberships (paid monthly tiers), Super Chats and tips (viewers send coins), live streaming, community posts with polls, custom channel emoji, cards (timed in-video links), end screens, premieres, playlists, and analytics.
- CHANNEL: Customize your channel with a banner, avatar, an About tab with links, and a trailer for non-subscribers.
- SAFETY: There are community guidelines and a 3-strike system; videos can be reported, and repeated violations can terminate a channel. Creators can appeal removals.
- NOTE: Payments and ad revenue are currently simulated in this deployment unless the owner has connected real provider keys (Stripe, Razorpay/UPI, PayPal, Google AdSense).

If asked something you can't answer from these facts, be honest and point them to Creator Studio or support rather than guessing.`;

// Lightweight FAQ used when no API key is configured (or the API call fails).
const FAQ = [
  { k: ['earn', 'money', 'revenue', 'how much', 'paid', 'income'],
    a: 'Once monetized, you earn a share of your videos\' ad revenue: 70% to you, 10% to the viewer watching, 20% to the platform. Earnings show as coins (1000 coins = $1) and are tracked in Creator Studio; real ad revenue is what funds payouts.' },
  { k: ['monetiz', 'enable', 'eligible', 'requirement', 'qualify'],
    a: 'To enable monetization you need about 500 subscribers and 2000 watch hours (roughly half of YouTube\'s bar), plus identity verification (KYC). Then click "Enable monetization" in Creator Studio. Until you reach that, the platform keeps the ad revenue.' },
  { k: ['payout', 'withdraw', 'cash out', 'cashout', 'paypal', 'upi', 'stripe', 'bank'],
    a: 'Once you\'re monetized, cash out from Creator Studio via PayPal (worldwide), UPI (India), or Stripe (bank). Minimum payout is 1000 coins ($1), no fee, KYC required first. Payouts are backed by real ad revenue, which grows as the platform builds its audience.' },
  { k: ['kyc', 'verify', 'identity', 'verification'],
    a: 'KYC is identity verification — you submit your legal name and a government ID (PAN for India) in Creator Studio. It is required before you can withdraw earnings.' },
  { k: ['upload', 'post', 'publish', 'thumbnail', 'video'],
    a: 'Use the Upload button. You can add a custom thumbnail, tags/#hashtags, set visibility (public/unlisted/private), schedule publishing, mark it a Short, make it members-only, add captions, and set up a Premiere with cards and an end screen.' },
  { k: ['member', 'membership', 'tier', 'subscri'],
    a: 'Channel memberships let fans pay a monthly coin price to join a tier and unlock perks — members-only videos and posts, a loyalty badge in comments and live chat, and your custom channel emoji. Set tiers up on your channel\'s Membership tab.' },
  { k: ['live', 'stream', 'super chat', 'superchat', 'tip'],
    a: 'You can go live with real-time chat, and viewers can send Super Chats during a stream or tip coins on any video — the coins go straight to you.' },
  { k: ['coin', 'currency', 'top up', 'topup', 'wallet'],
    a: 'Coins are the platform currency: 1000 coins = $1.00. Viewers can buy coins to tip creators or send Super Chats, and creators earn coins from ad revenue.' },
  { k: ['premiere', 'card', 'end screen', 'endscreen'],
    a: 'When uploading you can schedule a Premiere (a shared countdown, then it plays for everyone at once), add up to 5 cards (timed in-video links to your other videos), and show an end screen suggesting more of your content. Manage cards/end screens from "Your videos".' },
  { k: ['strike', 'removed', 'report', 'appeal', 'guideline', 'terminat'],
    a: 'Viomocoin has community guidelines and a 3-strike system. Videos can be reported and removed for violations; at 3 strikes a channel is terminated. If your video was removed unfairly, you can appeal it from the video page.' },
  { k: ['customize', 'banner', 'avatar', 'about', 'trailer', 'channel'],
    a: 'Customize your channel with a banner, avatar, an About tab with links, and a channel trailer shown to non-subscribers — all from the "🎨 Customize channel" button on your channel page.' },
];

function localAnswer(message) {
  const m = String(message || '').toLowerCase();
  let best = null, bestScore = 0;
  for (const item of FAQ) {
    const score = item.k.reduce((n, kw) => n + (m.includes(kw) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = item; }
  }
  if (best && bestScore > 0) return best.a;
  return "I can help with earning, monetization, payouts, KYC, uploading, memberships, live streaming, cards & premieres, and channel setup. Could you rephrase your question — or check Creator Studio for account-specific details?";
}

async function llmAnswer(messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, system: KB, messages }),
  });
  const d = await res.json();
  if (!res.ok) throw new Error(d?.error?.message || 'Anthropic API error');
  const text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return text || "Sorry, I couldn't come up with an answer just now.";
}

module.exports = {
  enabled: LIVE,
  model: MODEL,
  /** history: array of prior {role:'user'|'assistant', content} turns. */
  async answer(message, history = []) {
    if (!LIVE) return { reply: localAnswer(message), mode: 'faq' };
    try {
      const msgs = [...history, { role: 'user', content: message }];
      return { reply: await llmAnswer(msgs), mode: 'ai' };
    } catch (e) {
      // Degrade gracefully to the FAQ if the API is down / misconfigured.
      return { reply: localAnswer(message), mode: 'faq', note: e.message };
    }
  },
};
