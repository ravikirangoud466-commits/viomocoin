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
- EARNINGS: Creators earn from ad revenue on their videos, starting from the very first view — there is NO subscriber gate to start earning. Each ad view's revenue is split three ways: the creator keeps 70%, the viewer watching earns 10% (watch-to-earn), and the platform keeps 20%.
- COINS: The currency is coins. 1000 coins = $1.00. New users get a 100-coin welcome bonus.
- MONETIZATION: To turn on ad monetization, a creator needs about 100 subscribers AND 4 watch hours, must pass identity verification (KYC), then click "Enable monetization" in Creator Studio. Before that, ads still run but the platform keeps that revenue.
- PAYOUTS: Creators cash out from Creator Studio. Three methods: PayPal (worldwide, paid in $), UPI (India, paid in ₹), and Stripe (bank, worldwide). Minimum payout is 1000 coins ($1). No withdrawal fee. Identity verification (KYC) is required before the first withdrawal.
- UPLOADING: Use the Upload button. You can add a custom thumbnail, tags/#hashtags, set visibility (public / unlisted / private), schedule publishing, mark a video as a Short, make it members-only, add captions, schedule a Premiere, and add cards + an end screen.
- TOOLS: Creators also have channel memberships (paid monthly tiers), Super Chats and tips (viewers send coins), live streaming, community posts with polls, custom channel emoji, cards (timed in-video links), end screens, premieres, playlists, and analytics.
- CHANNEL: Customize your channel with a banner, avatar, an About tab with links, and a trailer for non-subscribers.
- SAFETY: There are community guidelines and a 3-strike system; videos can be reported, and repeated violations can terminate a channel. Creators can appeal removals.
- NOTE: Payments and ad revenue are currently simulated in this deployment unless the owner has connected real provider keys (Stripe, Razorpay/UPI, PayPal, Google AdSense).

If asked something you can't answer from these facts, be honest and point them to Creator Studio or support rather than guessing.`;

// Lightweight FAQ used when no API key is configured (or the API call fails).
const FAQ = [
  { k: ['earn', 'money', 'revenue', 'how much', 'paid', 'income'],
    a: 'You earn from ad revenue on your videos — starting from your very first view, with no subscriber gate. Each ad view is split 70% to you, 10% to the viewer watching, and 20% to the platform. 1000 coins = $1. Track it all in Creator Studio.' },
  { k: ['monetiz', 'enable', 'eligible', 'requirement', 'qualify'],
    a: 'To enable monetization you need about 100 subscribers and 4 watch hours, plus identity verification (KYC). Then click "Enable monetization" in Creator Studio. Ads run before that too, but the platform keeps that revenue until you enable it.' },
  { k: ['payout', 'withdraw', 'cash out', 'cashout', 'paypal', 'upi', 'stripe', 'bank'],
    a: 'Cash out from Creator Studio using PayPal (worldwide), UPI (India), or Stripe (bank). The minimum payout is 1000 coins ($1), there is no withdrawal fee, and you must complete identity verification (KYC) before your first withdrawal.' },
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
