# Viomocoin 🎬🪙

*Watch. Upload. Earn.* — a YouTube-style video platform where **creators earn coins for engagement and cash out real money via Stripe or UPI**.

Built as a full-stack app: Node/Express + SQLite backend, JWT accounts with email verification & 2FA, file uploads, comments, channel subscriptions, Stripe/UPI payouts, KYC, moderation, creator analytics, and Google AdSense. Frontend is a single-page app (vanilla JS, no build step).

## Features

- **Accounts** — email/password signup & login with **email verification**, **password reset**, and optional **email-based two-factor auth (2FA)** (passwords hashed with bcrypt, sessions via JWT).
- **Creator analytics** — a dashboard with watch-time-per-day charts, traffic-source breakdown, and top videos by watch time.
- **Upload & stream** — real video files stored on the server, streamed with HTTP range requests.
- **Publishing controls** — custom thumbnails, visibility (**public / unlisted / private**), **scheduled publishing**, hashtags/tags, and metadata editing (`PATCH /api/videos/:id`). Unlisted videos are link-only; private and scheduled videos are creator-only.
- **Real search** — SQLite **FTS5 full-text** across title, description, tags and channel, with **autocomplete** (`/api/search/suggest`), relevance/newest/most-viewed sorting, and category filters. Hidden videos never leak into search.
- **Personalised home feed** — a ranking heuristic over your subscriptions, the categories you actually watch, popularity and recency (`?feed=recommended`).
- **Watch history & Watch Later** — full history with per-item and bulk clearing; a dedicated Watch Later queue.
- **Likes & dislikes** — mutually exclusive, as on YouTube.
- **Player** — playback-speed cycling, theater mode, Picture-in-Picture mini-player, autoplay-next, a quality selector (single source rendition until transcoding is enabled), **WebVTT captions** via a `<track>`, and **auto-detected chapters** from `0:00 Label` lines in the description.
- **Shorts** — a dedicated vertical, scroll-snap feed with per-Short view/ad counting; mark any upload as a Short.
- **Installable PWA** — web-app manifest + offline service worker + install button (the mobile-app substitute in this environment).
- **Advanced analytics** — estimated revenue-per-day chart, viewer **geography** (country from CDN header or browser locale), **impressions + CTR**, and an average-retention metric, on top of watch-time and traffic sources.
- **Sign in with Google** — OAuth code flow (`oauth.js`), enabled with `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`.
- **i18n** — interface language switcher (English, हिन्दी, Español, Français), persisted per account.
- **Legal & privacy** — Terms of Service + Privacy Policy pages, a cookie-consent banner, and full **GDPR** self-service (download all your data, permanently delete your account) plus **tax forms** (W-9 / W-8BEN).
- **Cloud-ready adapters** (config-driven, with local fallbacks):
  - `storage.js` — mirrors uploads to **S3 + CDN** when `S3_*` / `CDN_BASE_URL` are set.
  - `transcode.js` — probes real duration and generates **HLS renditions** when `ffmpeg` is present (`ENABLE_HLS=1`); otherwise serves the source.
  - `livemedia.js` — issues ingest/playback credentials for a real **LiveKit/RTMP** media server when configured; otherwise the built-in browser-camera preview + chat.
- **Observability** — `/health`, `/metrics` (request counts, statuses, memory, adapter status), and slow/error request logging.
- **Earnings model — ad revenue, split three ways** (see [economy.js](economy.js)):
  - Every ad view on a monetized video generates `AD_REVENUE_COINS` (default 10 coins = $0.01), split three ways: the **creator keeps 70%**, the **viewer watching earns 10%** (watch-to-earn), and the **platform owner keeps 20%**.
  - The shares are configurable: `PLATFORM_COMMISSION_RATE` (owner, default 0.20) and `VIEWER_REWARD_RATE` (viewer, default 0.10); the creator keeps whatever's left. The owner's and viewer's shares are credited straight to their own coin balances. If the watcher isn't signed in (or is the creator watching their own video), the viewer's 10% falls to the platform.
  - **Views, likes and watch-time do NOT mint coins** — they're pure engagement metrics; the only watch-based earning is the viewer's 10% share of an actual ad view.
  - Coins are just a money unit: **1000 coins = $1.00**. Creators cash out their full balance — **no withdrawal fee** (the commission is already taken from ad revenue up front).
  - New users get a small welcome credit (`SIGNUP_BONUS`) so they can tip.
- **Monetization criteria** (like the YouTube Partner Program): a creator must reach `MONETIZATION_MIN_SUBS` subscribers **and** `MONETIZATION_MIN_WATCH_HOURS` watch hours (demo defaults 100 / 4; YouTube uses 1000 / 4000) **and** pass KYC, then click **Enable monetization** in Creator Studio. Until then, ads still run on their videos but the **platform keeps that revenue** — the creator earns $0 from ads. Progress bars in Studio show how close they are.
- **Google AdSense** — the app renders real AdSense ad units when you set `ADSENSE_CLIENT` (your `ca-pub-…` id) and `ADSENSE_SLOT`; otherwise it shows labeled placeholders. ⚠️ You must supply **your own approved AdSense account and a live deployed domain** — AdSense does not serve on `localhost`, and true per-video ad monetization would use Google Ad Manager + the IMA/VAST SDK. The in-app ad-revenue split is simulated until a real ad network is connected.
- **Monetized live streaming** — viewers spend coins on **Super Chats** (tiered, highlighted, pinned in live chat); the coins transfer 100% to the streamer. Regular videos also have a **🪙 Tip** button. Viewers get coins via wallet top-up.
- **Coin wallet top-up** — an “Add coins” purchase flow (simulated; production would use Stripe Checkout) so viewers can buy coins to spend on tips/Super Chats.
- **Notifications** — a bell with an unread badge and a panel; users are notified of new subscribers, comments, Super Chats/tips, new videos from subscriptions, and strikes.
- **Threaded comments** — replies (one level, like YouTube), **comment likes**, creator **❤ hearts**, a **📌 pinned** comment per video, "Creator" badges, and creator moderation (delete any comment; deleting a parent removes its replies). Sorted pinned-first, then by likes.
- **Community posts & polls** — channels post updates with optional multi-option polls; subscribers get notified, can like, and vote (changing a vote moves the count rather than adding one). Live result bars.
- **Channel memberships** — creators define paid monthly tiers (priced in coins, with perks); fans join and the coins transfer to the creator. 30-day terms, member counts, duplicate/self-join guarded.
- **Merch shelf** — creators list products (title, price, link) on a Merch tab; URLs validated.
- **Members-only content & perks** — creators can mark **videos** and **community posts** as members-only (non-members hit a paywall gate prompting them to join a tier); paying members get a **loyalty badge** (their tier name) next to their name in comments and live chat, and creators can define **custom channel emoji** (`:code:` → symbol) that members use anywhere text is rendered.
- **Channel customization** — a YouTube-style channel page with an uploadable **banner** and **avatar**, an **About** tab (description + external links), tabbed navigation (Videos / Community / Membership / Merch / About), and a **channel trailer** auto-played for non-subscribers. Edited through a “🎨 Customize channel” modal.
- **Cards, end screens & premieres** — creators add up to 5 **cards** (timed in-video pop-ups linking to another of their videos), an optional **end screen** of suggested videos shown when playback finishes, and can schedule a **premiere** (a future start time with a live shared countdown page, a “🎬 Premiere” badge in feeds, and a notification to subscribers). Cards and end screens are managed from a “🎴 Cards & end screen” editor on each of your videos.
- **Subscriptions** — subscribe to channels; a Subscriptions feed and per-channel pages.
- **Playlists** — create playlists and save any video with “＋ Save”.
- **Category browsing** — an Explore page with category tiles plus category chips on Home.
- **Live streaming** — creators go live (browser-camera preview); viewers watch with real-time **live chat** + viewer counts. *(Demo note: cross-viewer video delivery needs an RTMP/WebRTC media server; the session/presence/chat plumbing is implemented here.)*
- **Content moderation** — viewers report videos with a reason; the owner reviews a moderation queue and can remove violations or dismiss false reports. Removed videos are hidden from everyone but their creator.
- **Abuse & safety** — sliding-window **rate limiting** (comments/reports/uploads/appeals), **view-fraud detection** (caps counted views per viewer and flags spikes), lightweight **Content ID** (SHA-256 file fingerprint flags duplicate re-uploads + notifies the original creator), **strike appeals** (approving restores the video and removes the strike), and **age restriction (18+)** with an **age gate** + **Restricted Mode**. The owner's Moderation page has Reports / Appeals / Abuse-flags tabs.
- **Community guidelines & auto-strikes** — a published guidelines page and a YouTube-style **3-strike system**. A removed video (by a moderator, or **automatically after 5 community reports**) gives the channel a strike; at **3 strikes the channel is terminated automatically** — all its videos come down and the account is blocked. Configurable via `STRIKE_LIMIT` / `AUTO_REMOVE_REPORTS`.
- **Creator Studio** — balance, lifetime earnings, views, subscribers, per-video breakdown, payout history.
- **Payouts, two ways:**
  - 🇮🇳 **UPI** — creators enter any UPI ID (PhonePe `@ybl`, Google Pay `@okhdfcbank`, Paytm `@paytm`, BHIM…). Paid in ₹ via **Razorpay Payouts (RazorpayX)**.
  - 💳 **Stripe** — international bank payouts via **Stripe Connect**. Paid in $.
- **KYC verification** — creators must verify their identity (legal name + government ID; PAN for India) before withdrawing. Auto-approved in demo mode; wire a real provider (Onfido/Persona/Stripe Identity) for production.
- **Payout webhooks** — `/api/webhooks/stripe` and `/api/webhooks/razorpay` verify signatures and auto-update payout status (`paid`/`failed`/`reversed`). On a failed/reversed payout the creator's coins are **automatically refunded** and the platform fee reversed.
- **Platform commission** — the app owner takes a configurable cut (default **20%**) of every withdrawal, shown as a live breakdown before cash-out.
- **Google AdSense** — real ad units render when configured; ad impressions book platform ad revenue and pay creators an ad-share.
- **Owner dashboard** — the owner sees a **Platform** view with total commission + ad revenue, payouts, and community stats.
  Economy: **1,000 coins = $1.00**, minimum payout $1.00, ~₹83/$ for UPI.

## Run it

```bash
cd viomocoin
npm install
npm start
# open http://localhost:5178
```

No database or extra services to set up — SQLite (`viomocoin.db`) and the `uploads/` folder are created automatically. Emails, Stripe, and UPI all run in a safe **simulated mode** until you add real credentials.

## Stripe payouts

Out of the box, payouts run in **simulated mode** — the full cash-out flow works end to end, but no real money moves (statuses show as `simulated`). To enable **real** payouts:

1. Copy `.env.example` to `.env`.
2. Add your Stripe secret key: `STRIPE_SECRET_KEY=sk_test_...` (use a test key first).
3. Set a strong `JWT_SECRET` and the correct `BASE_URL`.
4. Restart the server.

Now "Connect Stripe" in Creator Studio launches real Stripe Connect Express onboarding, and cash-outs create real `transfers` to the creator's connected account. Fund your platform balance in test mode to see transfers succeed.

> Note: real payouts require a funded platform Stripe balance and completed creator onboarding (`payouts_enabled`). The server enforces both.

## Project layout

```
viomocoin/
├─ server.js        Express app + all API routes
├─ db.js            SQLite schema (node:sqlite, no native build)
├─ economy.js       Coin/earning rules (single source of truth)
├─ stripe.js        Stripe Connect helper (real + simulated modes)
├─ upi.js           UPI/Razorpay payout helper (real + simulated)
├─ mailer.js        Email helper (SMTP + simulated modes)
├─ public/index.html  Single-page frontend
└─ uploads/         Uploaded video files
```

## API overview

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/auth/signup`, `/api/auth/login` | Accounts |
| GET | `/api/verify-email` | Email verification link |
| POST | `/api/auth/resend-verification` | Resend verification |
| POST | `/api/auth/forgot-password`, `/reset-password` | Password reset |
| POST | `/api/auth/2fa/verify`, `/2fa/resend` | Email 2FA at login |
| PUT | `/api/auth/2fa` | Enable/disable 2FA |
| GET | `/api/me` | Current user |
| GET | `/api/analytics` | Creator analytics (watch-time, sources) |
| GET | `/api/videos` | Feed (filter by `category`, `q`, `channel`) |
| GET/POST/DELETE | `/api/videos[/:id]` | Video CRUD (upload = multipart) |
| POST | `/api/videos/:id/view` `/like` `/watch` `/ad` | Earning events |
| GET/POST | `/api/videos/:id/comments` | Comments |
| POST | `/api/channels/:id/subscribe` | Toggle subscription |
| POST | `/api/videos/:id/report` | Report a video |
| POST | `/api/videos/:id/tip`, `/api/live/:id/superchat` | Send coins to a creator |
| POST | `/api/wallet/topup` | Add coins (simulated) |
| GET/POST | `/api/notifications[/read]` | Notifications |
| GET/POST | `/api/moderation/*` | Owner moderation queue + actions |
| GET | `/api/config` | Public config (AdSense, rates) |
| GET | `/api/studio` | Creator dashboard data |
| PUT | `/api/payouts/upi` `/method` | Set UPI ID / choose payout method |
| POST | `/api/kyc` | Submit identity verification |
| POST | `/api/payouts/connect` `/cashout` | Stripe Connect + withdraw (KYC + commission applied) |
| POST | `/api/webhooks/stripe` `/razorpay` | Signed payout-status callbacks |
| GET | `/api/platform/summary` | Owner-only platform earnings |

## Disclaimer

This is a reference implementation for learning/prototyping. Before running a real money platform you'd also want: email verification, rate limiting, content moderation, a fraud/anti-bot system for view farming, Stripe webhooks for transfer status, HTTPS, and legal/tax compliance for creator payouts.
