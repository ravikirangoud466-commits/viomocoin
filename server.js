'use strict';
// Load .env if present (Node 20.12+ has process.loadEnvFile).
try { require('node:process').loadEnvFile(); } catch { /* no .env — that's fine */ }

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');

const db = require('./db');
const eco = require('./economy');
const stripe = require('./stripe');
const upi = require('./upi');
const mailer = require('./mailer');
const store = require('./storage');
const transcode = require('./transcode');
const livemedia = require('./livemedia');
const oauth = require('./oauth');
const kyc = require('./kyc');
const paypal = require('./paypal');
const assistant = require('./assistant');

const BASE_URL = process.env.BASE_URL || 'http://localhost:5178';
const OWNER_EMAIL = (process.env.OWNER_EMAIL || '').trim().toLowerCase();
const ADSENSE_CLIENT = process.env.ADSENSE_CLIENT || '';   // ca-pub-xxxxxxxx
const ADSENSE_SLOT = process.env.ADSENSE_SLOT || '';       // ad unit slot id

const app = express();
const IS_PROD = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 5178;
const DEV_JWT_SECRET = 'viomocoin-dev-secret-change-me';
const JWT_SECRET = process.env.JWT_SECRET || DEV_JWT_SECRET;
// Never ship a public/placeholder/weak secret to production — auth tokens would be forgeable.
const WEAK_SECRETS = new Set([DEV_JWT_SECRET, 'change-me-to-a-long-random-string', 'change-me', 'secret']);
if (IS_PROD && (!process.env.JWT_SECRET || WEAK_SECRETS.has(JWT_SECRET) || JWT_SECRET.length < 24)) {
  console.error('FATAL: JWT_SECRET must be a strong, private, random value in production ' +
    '(NODE_ENV=production) — not the template placeholder, and at least 24 chars. Generate one with:\n' +
    '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  process.exit(1);
}
// Uploads dir is configurable so it can point at a persistent/mounted volume in production
// (on ephemeral hosts, the default ./uploads is wiped on every redeploy — use S3 or a volume).
const UPLOAD_DIR = process.env.VIOMOCOIN_UPLOAD_DIR || path.join(__dirname, 'uploads');
// Ensure the uploads dir exists — it may be a freshly-mounted volume with nothing in it.
fs.mkdirSync(path.join(UPLOAD_DIR, 'hls'), { recursive: true });

app.set('trust proxy', true);
// Capture the raw body so webhook signatures can be verified.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

/* ----------------------------- observability ----------------------------- */
const startedAt = Date.now();
const metrics = { requests: 0, errors: 0, byStatus: {}, slowest_ms: 0 };
app.use((req, res, next) => {
  const t0 = Date.now();
  metrics.requests++;
  res.on('finish', () => {
    const ms = Date.now() - t0;
    if (ms > metrics.slowest_ms) metrics.slowest_ms = ms;
    metrics.byStatus[res.statusCode] = (metrics.byStatus[res.statusCode] || 0) + 1;
    if (res.statusCode >= 500) metrics.errors++;
    if (ms > 800 || res.statusCode >= 500) console.log(`[req] ${res.statusCode} ${req.method} ${req.path} ${ms}ms`);
  });
  next();
});
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime_s: Math.round((Date.now() - startedAt) / 1000) }));
app.get('/metrics', (_req, res) => {
  res.json({
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    ...metrics,
    users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    videos: db.prepare('SELECT COUNT(*) c FROM videos').get().c,
    adapters: { storage: store.info(), transcode: transcode.info(), live: livemedia.info(), oauth: oauth.enabled },
    mail: { simulated: mailer.simulated, ready: mailer.ready }, // ready: null=checking, true=SMTP ok, false=failed
    memory_mb: Math.round(process.memoryUsage().rss / 1048576),
  });
});

/* ----------------------------- helpers ----------------------------- */
const PALETTE = ['#ff2d55', '#ffb300', '#2ec27e', '#3a86ff', '#8338ec', '#fb5607', '#06d6a0', '#e63946'];
function colorFor(s) {
  let h = 0;
  for (const c of String(s)) h = c.charCodeAt(0) + ((h << 5) - h);
  return PALETTE[Math.abs(h) % PALETTE.length];
}
function sign(user) {
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
}
const genToken = () => crypto.randomBytes(32).toString('hex');
const genCode = () => String(crypto.randomInt(100000, 1000000)); // 6-digit

// Generate + email a login 2FA code. Returns the code in simulated mail mode.
async function sendTwoFactor(user) {
  const code = genCode();
  db.prepare('UPDATE users SET twofa_code=?, twofa_expires=? WHERE id=?').run(code, Date.now() + 10 * 60e3, user.id);
  // Fire-and-forget: a slow/broken SMTP must never hang the login response.
  mailer.send(user.email, 'Your Viomocoin login code', {
    text: `Your Viomocoin verification code is ${code}\n\nIt expires in 10 minutes. If you didn't try to sign in, change your password.`,
  }).catch(e => console.error('[mail] 2FA send failed:', e.message));
  return mailer.simulated ? code : null; // dev-only code
}

// Create + store a fresh email-verification token and email the link.
async function sendVerification(user) {
  const token = genToken();
  db.prepare('UPDATE users SET verify_token=?, verify_expires=? WHERE id=?')
    .run(token, Date.now() + 24 * 3600e3, user.id);
  const link = `${BASE_URL}/api/verify-email?token=${token}`;
  // Fire-and-forget: a slow/broken SMTP must never hang or 502 the signup.
  mailer.send(user.email, 'Verify your Viomocoin email', {
    text: `Welcome to Viomocoin! Confirm your email:\n${link}\n\nThis link expires in 24 hours.`,
  }).catch(e => console.error('[mail] verification send failed:', e.message));
  return mailer.simulated ? link : null; // dev-only link
}
// The app owner (you) — collects commission + ad revenue. First user by default.
function isOwner(u) {
  if (!u) return false;
  if (OWNER_EMAIL) return u.email === OWNER_EMAIL;
  return u.id === 1;
}
function publicUser(u) {
  return {
    id: u.id, email: u.email, channel_name: u.channel_name,
    avatar_color: u.avatar_color, avatar_url: u.avatar_img ? store.urlFor(u.avatar_img) : null,
    coins: u.coins, cashed_out: u.cashed_out,
    stripe_connected: !!u.stripe_account_id,
    payout_method: u.payout_method || 'stripe',
    upi_id: u.upi_id || null,
    kyc_status: u.kyc_status || 'unverified',
    kyc_name: u.kyc_name || null,
    email_verified: !!u.email_verified,
    twofa_enabled: !!u.twofa_enabled,
    monetization_enabled: !!u.monetization_enabled,
    birth_year: u.birth_year || null,
    age: userAge(u),
    restricted_mode: !!u.restricted_mode,
    locale: u.locale || 'en',
    tax_form: u.tax_form || null,
    has_google: !!u.google_id,
    strikes: u.strikes || 0,
    strike_limit: eco.STRIKE_LIMIT,
    terminated: !!u.terminated,
    terminated_reason: u.terminated_reason || null,
    is_owner: isOwner(u),
  };
}
// Give a creator a community-guidelines strike; auto-terminate at the limit.
function issueStrike(userId, videoId, reason) {
  db.prepare('INSERT INTO strikes (user_id, video_id, reason, created_at) VALUES (?,?,?,?)')
    .run(userId, videoId || null, reason, Date.now());
  db.prepare('UPDATE users SET strikes = strikes + 1 WHERE id=?').run(userId);
  const u = getUserById(userId);
  notify(userId, 'strike', `⚠️ Community guideline strike ${u.strikes} of ${eco.STRIKE_LIMIT} — a video was removed.`, 'guidelines');
  if (u.strikes >= eco.STRIKE_LIMIT && !u.terminated) terminateChannel(u, `${eco.STRIKE_LIMIT} community guideline strikes`);
  return u.strikes;
}
// Terminate a channel: flag the account and remove all its videos.
function terminateChannel(user, reason) {
  db.prepare('UPDATE users SET terminated=1, terminated_at=?, terminated_reason=? WHERE id=?')
    .run(Date.now(), reason, user.id);
  db.prepare("UPDATE videos SET removed=1, removed_reason='Channel terminated for repeated violations' WHERE user_id=? AND removed=0")
    .run(user.id);
  db.prepare("UPDATE live_streams SET status='ended', ended_at=? WHERE user_id=? AND status='live'").run(Date.now(), user.id);
}
function creditPlatform(type, cents, refUser, refVideo) {
  db.prepare('INSERT INTO platform_ledger (type, amount_cents, ref_user_id, ref_video_id, created_at) VALUES (?,?,?,?,?)')
    .run(type, cents, refUser || null, refVideo || null, Date.now());
}
// The app owner's user account (receives the ad-revenue commission).
function getOwnerUser() {
  if (OWNER_EMAIL) return db.prepare('SELECT * FROM users WHERE email=?').get(OWNER_EMAIL);
  return getUserById(1);
}
// Add coins to the owner's own balance (their commission cut).
function creditOwnerAccount(coins) {
  const o = getOwnerUser();
  if (o) db.prepare('UPDATE users SET coins = coins + ? WHERE id=?').run(coins, o.id);
}
// A creator's monetization progress + status (like YouTube's partner requirements).
function monetizationStatus(userId) {
  const u = getUserById(userId);
  const subs = db.prepare('SELECT COUNT(*) c FROM subscriptions WHERE channel_id=?').get(userId).c;
  const watchSec = db.prepare("SELECT COALESCE(SUM(seconds),0) s FROM analytics_events WHERE owner_id=? AND kind='watch'").get(userId).s;
  const watchHours = watchSec / 3600;
  const eligible = subs >= eco.MONETIZATION_MIN_SUBS && watchHours >= eco.MONETIZATION_MIN_WATCH_HOURS;
  return {
    subs, watch_hours: watchHours, eligible,
    enabled: !!(u && u.monetization_enabled),
    min_subs: eco.MONETIZATION_MIN_SUBS, min_watch_hours: eco.MONETIZATION_MIN_WATCH_HOURS,
  };
}
/* ---------- abuse / rate limiting ---------- */
function actorOf(req) { return req.user ? 'u:' + req.user.id : 'ip:' + req.ip; }
// Sliding-window limiter. Returns { allowed, count }.
function rateLimit(actor, action, max, windowMs) {
  const now = Date.now();
  db.prepare('DELETE FROM rate_events WHERE ts < ?').run(now - Math.max(windowMs, 3600e3));
  const count = db.prepare('SELECT COUNT(*) c FROM rate_events WHERE actor=? AND action=? AND ts>=?').get(actor, action, now - windowMs).c;
  if (count >= max) return { allowed: false, count };
  db.prepare('INSERT INTO rate_events (actor, action, ts) VALUES (?,?,?)').run(actor, action, now);
  return { allowed: true, count: count + 1 };
}
// Express guard: 429 when an actor exceeds `max` of `action` per `windowMs`.
function limit(action, max, windowMs) {
  return (req, res, next) => {
    const r = rateLimit(actorOf(req), action, max, windowMs);
    if (!r.allowed) return res.status(429).json({ error: 'You are doing that too fast — please slow down.' });
    next();
  };
}
function flagFraud(kind, refUser, refVideo, detail) {
  db.prepare('INSERT INTO fraud_flags (kind, ref_user, ref_video, detail, created_at) VALUES (?,?,?,?,?)')
    .run(kind, refUser || null, refVideo || null, detail || null, Date.now());
}

/* ---------- content fingerprint (lightweight Content ID / dupe detection) ---------- */
function hashFileSync(p) {
  const fd = fs.openSync(p, 'r'); const buf = Buffer.alloc(1 << 16); const h = crypto.createHash('sha256');
  let n; try { while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return h.digest('hex');
}

/* ---------- age gate / restricted mode ---------- */
function userAge(u) {
  if (!u || !u.birth_year) return null;
  return new Date().getFullYear() - u.birth_year;
}
function canSeeMature(u, v) {
  if (!v.age_restricted) return true;
  if (!u) return false;                    // must be signed in
  if (u.restricted_mode) return false;     // restricted mode hides mature content
  const age = userAge(u);
  return age !== null && age >= 18;
}

// Create an in-app notification for a user (skips notifying yourself).
function notify(userId, type, body, page, arg) {
  if (!userId) return;
  db.prepare('INSERT INTO notifications (user_id, type, body, page, arg, created_at) VALUES (?,?,?,?,?,?)')
    .run(userId, type, body, page || null, arg != null ? String(arg) : null, Date.now());
}
function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Sign in required.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = getUserById(payload.id);
    if (!req.user) return res.status(401).json({ error: 'Account not found.' });
    if (req.user.terminated)
      return res.status(403).json({ error: 'Your channel was terminated for repeated community guideline violations.' });
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
}
function optionalAuth(req, _res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (token) {
    try { req.user = getUserById(jwt.verify(token, JWT_SECRET).id); } catch { /* ignore */ }
  }
  next();
}
// Attach channel + viewer-specific flags to a raw video row.
function decorateVideo(v, viewerId) {
  const owner = getUserById(v.user_id);
  const liked = viewerId
    ? !!db.prepare('SELECT 1 FROM video_likes WHERE user_id=? AND video_id=?').get(viewerId, v.id)
    : false;
  const disliked = viewerId
    ? !!db.prepare('SELECT 1 FROM video_dislikes WHERE user_id=? AND video_id=?').get(viewerId, v.id)
    : false;
  let chapters = [], cards = [];
  try { chapters = v.chapters ? JSON.parse(v.chapters) : []; } catch { chapters = []; }
  try { cards = v.cards ? JSON.parse(v.cards) : []; } catch { cards = []; }
  return {
    ...v,
    disliked,
    thumbnail_url: v.thumbnail ? store.urlFor(v.thumbnail) : null,
    tags: (v.tags || '').split(' ').filter(Boolean),
    age_restricted: !!v.age_restricted,
    members_only: !!v.members_only,
    is_short: !!v.is_short,
    has_captions: !!v.captions,
    captions_url: v.captions ? '/api/videos/' + v.id + '/captions.vtt' : null,
    chapters, cards,
    end_screen: v.end_screen === undefined ? true : !!v.end_screen,
    premiere_at: v.premiere_at || null,
    is_premiere: !!(v.premiere_at && v.premiere_at > Date.now()),
    scheduled: !!(v.publish_at && v.publish_at > Date.now()),
    channel_name: owner ? owner.channel_name : 'Unknown',
    channel_id: v.user_id,
    avatar_color: owner ? owner.avatar_color : '#555',
    avatar_url: owner && owner.avatar_img ? store.urlFor(owner.avatar_img) : null,
    liked,
    url: store.urlFor(v.filename),
  };
}

// Parse "0:00 Intro" style lines from a description into chapter markers.
function parseChapters(description) {
  const out = [];
  for (const line of String(description || '').split('\n')) {
    const m = line.match(/^\s*(?:(\d+):)?(\d{1,2}):(\d{2})\s+(.+?)\s*$/);
    if (m) {
      const t = (Number(m[1] || 0) * 3600) + (Number(m[2]) * 60) + Number(m[3]);
      out.push({ t, label: m[4].slice(0, 80) });
    }
  }
  return out.length >= 2 ? out.sort((a, b) => a.t - b.t) : []; // chapters need at least 2
}
// Validate cards: [{t:seconds, video_id, label}] pointing at real videos.
function parseCards(input) {
  let arr = input;
  if (typeof input === 'string') { try { arr = JSON.parse(input); } catch { arr = []; } }
  if (!Array.isArray(arr)) return '[]';
  const out = [];
  for (const c of arr.slice(0, 5)) {
    const vid = Number(c.video_id);
    if (!vid || !db.prepare('SELECT 1 FROM videos WHERE id=?').get(vid)) continue;
    out.push({ t: Math.max(0, Math.floor(Number(c.t) || 0)), video_id: vid, label: String(c.label || '').slice(0, 60) });
  }
  return JSON.stringify(out);
}
// Attach the target video's title/thumbnail/url to each card for rendering.
function enrichCards(cards) {
  return (cards || []).map(c => {
    const v = db.prepare('SELECT * FROM videos WHERE id=?').get(c.video_id);
    if (!v) return null;
    return { t: c.t, label: c.label || v.title, video_id: v.id, title: v.title,
      thumbnail_url: v.thumbnail ? store.urlFor(v.thumbnail) : null, url: store.urlFor(v.filename) };
  }).filter(Boolean);
}
// Minimal WebVTT validation/normalisation.
function normaliseVtt(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  return s.startsWith('WEBVTT') ? s.slice(0, 100000) : ('WEBVTT\n\n' + s).slice(0, 100000);
}

/* ----------------------------- auth ----------------------------- */
app.post('/api/auth/signup', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const channel = String(req.body.channel_name || '').trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (!channel) return res.status(400).json({ error: 'Choose a channel name.' });
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email))
    return res.status(409).json({ error: 'An account with that email already exists.' });

  const hash = await bcrypt.hash(password, 10);
  const info = db.prepare(
    'INSERT INTO users (email, password_hash, channel_name, avatar_color, coins, created_at) VALUES (?,?,?,?,?,?)'
  ).run(email, hash, channel, colorFor(channel), eco.SIGNUP_BONUS, Date.now());
  const user = getUserById(info.lastInsertRowid);
  if (eco.SIGNUP_BONUS) notify(user.id, 'bonus', `🎉 Welcome! You got ${eco.SIGNUP_BONUS} starter coins to tip creators.`, 'home');
  const devLink = await sendVerification(user);
  res.json({ token: sign(user), user: publicUser(user), dev_verify_link: devLink });
});

/* ---------- Google OAuth (Sign in with Google) ---------- */
app.get('/api/auth/google', (req, res) => {
  if (!oauth.enabled) return res.status(503).send('Google sign-in is not configured.');
  const state = jwt.sign({ n: crypto.randomBytes(8).toString('hex') }, JWT_SECRET, { expiresIn: '10m' });
  res.redirect(oauth.authUrl(state));
});
app.get('/api/auth/google/callback', async (req, res) => {
  if (!oauth.enabled) return res.redirect('/?oauth=disabled');
  try {
    jwt.verify(String(req.query.state || ''), JWT_SECRET);         // CSRF state check
    const profile = await oauth.exchange(String(req.query.code || ''));
    let user = db.prepare('SELECT * FROM users WHERE email=?').get(profile.email);
    if (!user) {
      const hash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 10);
      let name = profile.name.slice(0, 40) || profile.email.split('@')[0];
      // Ensure a unique-ish channel name isn't required; duplicates are fine here.
      const info = db.prepare(
        'INSERT INTO users (email, password_hash, channel_name, avatar_color, coins, email_verified, google_id, created_at) VALUES (?,?,?,?,?,1,?,?)'
      ).run(profile.email, hash, name, colorFor(name), eco.SIGNUP_BONUS, 'g', Date.now());
      user = getUserById(info.lastInsertRowid);
      notify(user.id, 'bonus', `🎉 Welcome! You got ${eco.SIGNUP_BONUS} starter coins.`, 'home');
    } else if (!user.google_id) {
      db.prepare('UPDATE users SET google_id=?, email_verified=1 WHERE id=?').run('g', user.id);
    }
    if (user.terminated) return res.redirect('/?oauth=terminated');
    res.redirect('/?token=' + sign(user));
  } catch (e) {
    res.redirect('/?oauth=failed');
  }
});

// Email verification link (clicked from the email) -> back to the app.
app.get('/api/verify-email', (req, res) => {
  const token = String(req.query.token || '');
  const u = token && db.prepare('SELECT * FROM users WHERE verify_token=?').get(token);
  if (!u || (u.verify_expires && u.verify_expires < Date.now()))
    return res.redirect('/?verify=invalid');
  db.prepare('UPDATE users SET email_verified=1, verify_token=NULL, verify_expires=NULL WHERE id=?').run(u.id);
  res.redirect('/?verify=ok');
});

app.post('/api/auth/resend-verification', auth, async (req, res) => {
  if (req.user.email_verified) return res.json({ ok: true, already: true });
  const devLink = await sendVerification(req.user);
  res.json({ ok: true, dev_verify_link: devLink });
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  let devLink = null;
  if (u) {
    const token = genToken();
    db.prepare('UPDATE users SET reset_token=?, reset_expires=? WHERE id=?').run(token, Date.now() + 3600e3, u.id);
    const link = `${BASE_URL}/?reset=${token}`;
    // Fire-and-forget: never hang the response on SMTP.
    mailer.send(u.email, 'Reset your Viomocoin password', {
      text: `Reset your password:\n${link}\n\nThis link expires in 1 hour. If you didn't request this, ignore it.`,
    }).catch(e => console.error('[mail] reset send failed:', e.message));
    if (mailer.simulated) devLink = link;
  }
  // Always OK — don't reveal whether the email exists.
  res.json({ ok: true, dev_reset_link: devLink });
});

app.post('/api/auth/reset-password', async (req, res) => {
  const token = String(req.body.token || '');
  const password = String(req.body.password || '');
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const u = token && db.prepare('SELECT * FROM users WHERE reset_token=?').get(token);
  if (!u || (u.reset_expires && u.reset_expires < Date.now()))
    return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
  const hash = await bcrypt.hash(password, 10);
  db.prepare('UPDATE users SET password_hash=?, reset_token=NULL, reset_expires=NULL WHERE id=?').run(hash, u.id);
  res.json({ ok: true });
});

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    return res.status(401).json({ error: 'Wrong email or password.' });
  if (user.terminated)
    return res.status(403).json({ error: 'This channel was terminated for repeated community guideline violations.' });

  // Email 2FA: don't issue the session yet — email a code and return a challenge.
  if (user.twofa_enabled) {
    const devCode = await sendTwoFactor(user);
    const challenge = jwt.sign({ id: user.id, twofa: true }, JWT_SECRET, { expiresIn: '10m' });
    return res.json({ twofa_required: true, challenge, dev_code: devCode });
  }
  res.json({ token: sign(user), user: publicUser(user) });
});

// Complete a 2FA login: verify the emailed code against the challenge.
app.post('/api/auth/2fa/verify', async (req, res) => {
  let payload;
  try { payload = jwt.verify(String(req.body.challenge || ''), JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Your login session expired. Please sign in again.' }); }
  if (!payload.twofa) return res.status(400).json({ error: 'Invalid challenge.' });
  const user = getUserById(payload.id);
  const code = String(req.body.code || '').trim();
  if (!user || !user.twofa_code || user.twofa_code !== code)
    return res.status(401).json({ error: 'That code is incorrect.' });
  if (user.twofa_expires && user.twofa_expires < Date.now())
    return res.status(401).json({ error: 'That code has expired. Please sign in again.' });
  db.prepare('UPDATE users SET twofa_code=NULL, twofa_expires=NULL WHERE id=?').run(user.id);
  res.json({ token: sign(user), user: publicUser(user) });
});

// Resend a 2FA code during login.
app.post('/api/auth/2fa/resend', async (req, res) => {
  let payload;
  try { payload = jwt.verify(String(req.body.challenge || ''), JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Your login session expired. Please sign in again.' }); }
  const user = getUserById(payload.id);
  if (!user) return res.status(404).json({ error: 'Account not found.' });
  const devCode = await sendTwoFactor(user);
  res.json({ ok: true, dev_code: devCode });
});

// Enable / disable 2FA (requires a verified email to turn on).
app.put('/api/auth/2fa', auth, (req, res) => {
  const enabled = !!req.body.enabled;
  if (enabled && !req.user.email_verified)
    return res.status(400).json({ error: 'Verify your email before enabling two-factor auth.' });
  db.prepare('UPDATE users SET twofa_enabled=?, twofa_code=NULL, twofa_expires=NULL WHERE id=?').run(enabled ? 1 : 0, req.user.id);
  res.json({ ok: true, twofa_enabled: enabled });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

// Set date of birth (year) — used for the age gate on 18+ content.
app.put('/api/account/age', auth, (req, res) => {
  const year = Math.floor(Number(req.body.birth_year) || 0);
  const thisYear = new Date().getFullYear();
  if (year < 1900 || year > thisYear - 13) return res.status(400).json({ error: 'Enter a valid birth year (you must be at least 13).' });
  db.prepare('UPDATE users SET birth_year=? WHERE id=?').run(year, req.user.id);
  res.json({ user: publicUser(getUserById(req.user.id)) });
});
// Toggle Restricted Mode (hides mature content).
app.put('/api/account/restricted', auth, (req, res) => {
  db.prepare('UPDATE users SET restricted_mode=? WHERE id=?').run(req.body.on ? 1 : 0, req.user.id);
  res.json({ user: publicUser(getUserById(req.user.id)) });
});
app.put('/api/account/locale', auth, (req, res) => {
  const locale = String(req.body.locale || 'en').slice(0, 5);
  db.prepare('UPDATE users SET locale=? WHERE id=?').run(locale, req.user.id);
  res.json({ ok: true, locale });
});

// Tax form (W-9 for US, W-8BEN for non-US) — required by law before real payouts at scale.
app.put('/api/account/tax', auth, (req, res) => {
  const form = req.body.form === 'W-9' ? 'W-9' : req.body.form === 'W-8BEN' ? 'W-8BEN' : null;
  const name = String(req.body.name || '').trim();
  const country = String(req.body.country || '').trim().toUpperCase();
  const id = String(req.body.tax_id || '').trim();
  if (!form) return res.status(400).json({ error: 'Choose W-9 (US) or W-8BEN (non-US).' });
  if (name.length < 3) return res.status(400).json({ error: 'Enter the name as it appears on your tax records.' });
  if (id.replace(/\D/g, '').length < 4) return res.status(400).json({ error: 'Enter a valid tax ID / SSN / TIN.' });
  db.prepare('UPDATE users SET tax_form=?, tax_name=?, tax_country=?, tax_id_last4=? WHERE id=?')
    .run(form, name.slice(0, 100), country, id.slice(-4), req.user.id);
  res.json({ ok: true, tax_form: form });
});

// GDPR — export everything we hold about the user as JSON.
app.get('/api/account/export', auth, (req, res) => {
  const uid = req.user.id;
  const one = (t, w = 'user_id') => db.prepare(`SELECT * FROM ${t} WHERE ${w}=?`).all(uid);
  const data = {
    exported_at: new Date().toISOString(),
    account: publicUser(getUserById(uid)),
    videos: db.prepare('SELECT id,title,description,category,visibility,views,likes,created_at FROM videos WHERE user_id=?').all(uid),
    comments: db.prepare('SELECT id,video_id,body,created_at FROM comments WHERE user_id=?').all(uid),
    playlists: one('playlists'), subscriptions: db.prepare('SELECT channel_id,created_at FROM subscriptions WHERE subscriber_id=?').all(uid),
    watch_history: one('watch_history'), payouts: one('payouts'), memberships: one('memberships'),
    community_posts: one('community_posts'), tax_on_file: getUserById(uid).tax_form || null,
  };
  res.setHeader('Content-Disposition', 'attachment; filename="viomocoin-my-data.json"');
  res.json(data);
});

// GDPR — permanently delete the account (requires password re-entry).
app.delete('/api/account', auth, async (req, res) => {
  if (isOwner(req.user)) return res.status(400).json({ error: 'The platform owner account cannot be self-deleted.' });
  const ok = await bcrypt.compare(String(req.body.password || ''), req.user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Wrong password.' });
  for (const f of db.prepare('SELECT filename, thumbnail FROM videos WHERE user_id=?').all(req.user.id)) {
    fs.unlink(path.join(UPLOAD_DIR, f.filename), () => {});
    if (f.thumbnail) fs.unlink(path.join(UPLOAD_DIR, f.thumbnail), () => {});
  }
  db.prepare('DELETE FROM videos_fts WHERE rowid IN (SELECT id FROM videos WHERE user_id=?)').run(req.user.id);
  db.prepare('DELETE FROM users WHERE id=?').run(req.user.id); // FKs cascade the rest
  res.json({ ok: true });
});

// Public config the frontend needs (ad units, economy rates, enabled providers).
app.get('/api/config', (_req, res) => {
  res.json({
    adsense: { client: ADSENSE_CLIENT, slot: ADSENSE_SLOT, enabled: !!ADSENSE_CLIENT },
    commission_rate: eco.PLATFORM_COMMISSION_RATE,
    coins_per_usd: eco.COINS_PER_USD,
    min_payout_coins: eco.MIN_PAYOUT_COINS,
    usd_to_inr: eco.USD_TO_INR,
    payouts: { stripe: true, upi: true },
    stripe_live: stripe.enabled,
    upi_live: upi.enabled,
    report_reasons: REPORT_REASONS,
    strike_limit: eco.STRIKE_LIMIT,
    auto_remove_reports: eco.AUTO_REMOVE_REPORTS,
    categories: CATEGORIES,
    superchat_tiers: eco.SUPERCHAT_TIERS,
    signup_bonus: eco.SIGNUP_BONUS,
    ad_revenue_coins: eco.AD_REVENUE_COINS,
    ad_split: eco.adSplit(),
    monetization_min_subs: eco.MONETIZATION_MIN_SUBS,
    monetization_min_watch_hours: eco.MONETIZATION_MIN_WATCH_HOURS,
    visibilities: VISIBILITIES,
    oauth_google: oauth.enabled,
    languages: [
      { code: 'en', label: 'English' }, { code: 'hi', label: 'हिन्दी' },
      { code: 'es', label: 'Español' }, { code: 'fr', label: 'Français' },
    ],
    adapters: { storage: store.info(), transcode: transcode.info(), live: livemedia.info() },
  });
});

const CATEGORIES = ['Gaming', 'Music', 'Education', 'Tech', 'Comedy', 'Vlog', 'Other'];

// Category browse tiles: count + a sample thumbnail per category.
app.get('/api/categories', (_req, res) => {
  const now = Date.now();
  const rows = CATEGORIES.map(cat => {
    const count = db.prepare(`SELECT COUNT(*) c FROM videos WHERE category=? AND ${LISTED_SQL}`).get(cat, now).c;
    const s = db.prepare(`SELECT filename, thumbnail FROM videos WHERE category=? AND ${LISTED_SQL} ORDER BY views DESC LIMIT 1`).get(cat, now);
    return {
      category: cat, count,
      thumb: s ? store.urlFor(s.filename) : null,
      poster: s && s.thumbnail ? store.urlFor(s.thumbnail) : null,
    };
  });
  res.json({ categories: rows });
});

/* ----------------------------- videos ----------------------------- */
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = (path.extname(file.originalname || '') || '.mp4').slice(0, 8);
    cb(null, crypto.randomUUID() + ext);
  },
});
// Max upload size in MB — raise via env (mind your disk space / host limits).
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 2048;
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (['thumbnail', 'banner', 'avatar'].includes(file.fieldname)) return cb(null, /^image\//.test(file.mimetype));
    cb(null, /^video\//.test(file.mimetype));
  },
});
const uploadFields = upload.fields([{ name: 'video', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }]);

/* ---- full-text search index (FTS5), kept in sync with the videos table ---- */
function syncFts(videoId) {
  const v = db.prepare('SELECT v.*, u.channel_name FROM videos v JOIN users u ON u.id=v.user_id WHERE v.id=?').get(videoId);
  db.prepare('DELETE FROM videos_fts WHERE rowid=?').run(videoId);
  if (v) db.prepare('INSERT INTO videos_fts(rowid,title,description,tags,channel) VALUES (?,?,?,?,?)')
    .run(v.id, v.title, v.description || '', v.tags || '', v.channel_name);
}
// Turn a user query into a safe FTS5 prefix query: `"foo"* AND "bar"*`
function ftsQuery(q) {
  const terms = String(q || '').toLowerCase().replace(/["*^:()#-]/g, ' ').split(/\s+/).filter(Boolean);
  if (!terms.length) return null;
  return terms.map(t => `"${t}"*`).join(' AND ');
}
// #hashtags from the tags field and the description, normalised + deduped.
function parseTags(input, description) {
  const out = [];
  const push = t => { t = String(t).replace(/^#/, '').toLowerCase(); if (t && /^[\p{L}\p{N}_]{1,30}$/u.test(t)) out.push(t); };
  (String(description || '').match(/#[\p{L}\p{N}_]+/gu) || []).forEach(push);
  String(input || '').split(/[,\s]+/).forEach(push);
  return [...new Set(out)].slice(0, 15).join(' ');
}
const VISIBILITIES = ['public', 'unlisted', 'private'];
// SQL fragment for "publicly listed right now" (excludes private/unlisted/scheduled/removed).
const LISTED_SQL = "removed=0 AND visibility='public' AND (publish_at IS NULL OR publish_at <= ?)";

// Rebuild the index once if it's empty but videos exist (e.g. after a schema upgrade).
if (db.prepare('SELECT COUNT(*) c FROM videos_fts').get().c === 0) {
  for (const r of db.prepare('SELECT id FROM videos').all()) syncFts(r.id);
}

// Personalised ranking: subscriptions + categories you actually watch + popularity + recency.
function recommendFor(uid, now) {
  const cands = db.prepare(`SELECT * FROM videos WHERE ${LISTED_SQL} ORDER BY created_at DESC LIMIT 300`).all(now);
  const subs = new Set(db.prepare('SELECT channel_id FROM subscriptions WHERE subscriber_id=?').all(uid).map(r => r.channel_id));
  const seen = new Set(db.prepare('SELECT video_id FROM watch_history WHERE user_id=?').all(uid).map(r => r.video_id));
  const catRows = db.prepare(
    'SELECT v.category, COUNT(*) c FROM watch_history h JOIN videos v ON v.id=h.video_id WHERE h.user_id=? GROUP BY v.category').all(uid);
  const catScore = Object.fromEntries(catRows.map(r => [r.category, r.c]));
  const maxCat = Math.max(1, ...catRows.map(r => r.c));
  return cands
    .map(v => {
      let s = 0;
      if (subs.has(v.user_id)) s += 50;                        // channels you follow
      s += 30 * ((catScore[v.category] || 0) / maxCat);        // topics you watch
      s += Math.log10(1 + v.views) * 8;                        // popularity
      s += Math.max(0, 20 - (now - v.created_at) / 86400000);  // recency
      if (seen.has(v.id)) s -= 40;                             // already watched
      if (v.user_id === uid) s -= 15;                          // your own uploads
      return { v, s };
    })
    .sort((a, b) => b.s - a.s)
    .map(x => x.v);
}

app.get('/api/videos', optionalAuth, (req, res) => {
  const { category, q, channel, sort, feed } = req.query;
  const now = Date.now();
  const uid = req.user?.id;
  const ownChannel = channel && uid && Number(channel) === uid;
  let rows;

  if (q) {
    // Full-text search across title, description, tags and channel name.
    const fq = ftsQuery(q);
    if (!fq) return res.json({ videos: [] });
    const ids = db.prepare('SELECT rowid AS id FROM videos_fts WHERE videos_fts MATCH ? ORDER BY rank LIMIT 100').all(fq).map(r => r.id);
    if (!ids.length) return res.json({ videos: [] });
    const ph = ids.map(() => '?').join(',');
    let sql = `SELECT * FROM videos WHERE id IN (${ph}) AND ${LISTED_SQL}`;
    const params = [...ids, now];
    if (category && category !== 'All') { sql += ' AND category=?'; params.push(category); }
    rows = db.prepare(sql).all(...params);
    const rank = new Map(ids.map((id, i) => [id, i]));
    if (sort === 'views') rows.sort((a, b) => b.views - a.views);
    else if (sort === 'date') rows.sort((a, b) => b.created_at - a.created_at);
    else rows.sort((a, b) => rank.get(a.id) - rank.get(b.id)); // relevance
  } else if (feed === 'shorts') {
    // Shorts: newest vertical clips first, most-recent-view-weighted a touch.
    rows = db.prepare(`SELECT * FROM videos WHERE is_short=1 AND ${LISTED_SQL} ORDER BY created_at DESC LIMIT 60`).all(now);
  } else if (feed === 'recommended' && uid) {
    rows = recommendFor(uid, now);
  } else if (feed === 'subscriptions' && uid) {
    rows = db.prepare(
      `SELECT v.* FROM videos v JOIN subscriptions s ON s.channel_id = v.user_id
       WHERE s.subscriber_id = ? AND ${LISTED_SQL} ORDER BY v.created_at DESC`
    ).all(uid, now);
  } else {
    const where = [], params = [];
    if (category && category !== 'All') { where.push('category = ?'); params.push(category); }
    if (channel) { where.push('user_id = ?'); params.push(Number(channel)); }
    // Creators see their own unlisted/private/scheduled videos on their own channel.
    if (!ownChannel) { where.push(LISTED_SQL); params.push(now); }
    let sql = 'SELECT * FROM videos' + (where.length ? ' WHERE ' + where.join(' AND ') : '');
    sql += sort === 'views' ? ' ORDER BY views DESC' : ' ORDER BY created_at DESC';
    rows = db.prepare(sql).all(...params);
  }
  // Hide age-restricted videos from anyone who can't view them (except on the creator's own channel).
  if (!ownChannel) rows = rows.filter(v => canSeeMature(req.user, v));
  res.json({ videos: rows.map(v => decorateVideo(v, uid)) });
});

// Search autocomplete.
app.get('/api/search/suggest', (req, res) => {
  const fq = ftsQuery(req.query.q || '');
  if (!fq) return res.json({ suggestions: [] });
  const now = Date.now();
  const ids = db.prepare('SELECT rowid AS id FROM videos_fts WHERE videos_fts MATCH ? ORDER BY rank LIMIT 30').all(fq).map(r => r.id);
  if (!ids.length) return res.json({ suggestions: [] });
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT title, tags FROM videos WHERE id IN (${ph}) AND ${LISTED_SQL} LIMIT 20`).all(...ids, now);
  const seen = new Set(), out = [];
  for (const r of rows) { if (!seen.has(r.title)) { seen.add(r.title); out.push({ text: r.title, kind: 'video' }); } }
  const term = String(req.query.q).toLowerCase().replace('#', '');
  for (const r of rows) for (const t of (r.tags || '').split(' ')) {
    if (t && t.startsWith(term) && !seen.has('#' + t)) { seen.add('#' + t); out.push({ text: '#' + t, kind: 'tag' }); }
  }
  res.json({ suggestions: out.slice(0, 8) });
});

app.get('/api/videos/:id', optionalAuth, (req, res) => {
  const v = db.prepare('SELECT * FROM videos WHERE id=?').get(Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'Video not found.' });
  const privileged = req.user && (req.user.id === v.user_id || isOwner(req.user));
  // A removed video is only visible to its creator or the platform owner.
  if (v.removed && !privileged)
    return res.status(410).json({ error: 'This video was removed for violating our guidelines.' });
  // Private videos: creator (or platform owner) only. Unlisted: anyone with the link.
  if (v.visibility === 'private' && !privileged)
    return res.status(404).json({ error: 'This video is private.' });
  // Scheduled videos stay hidden until their publish time.
  if (v.publish_at && v.publish_at > Date.now() && !privileged)
    return res.status(404).json({ error: 'This video has not been published yet.' });
  // Members-only gate: only the creator, platform owner, or an active member can watch.
  if (v.members_only && !privileged && !isChannelMember(req.user?.id, v.user_id)) {
    return res.status(402).json({ error: 'This video is for channel members only. Join the membership to watch.', members_only: true, channel_id: v.user_id });
  }
  // Age gate: 18+ content requires a signed-in adult who isn't in restricted mode.
  if (v.age_restricted && !privileged && !canSeeMature(req.user, v)) {
    const reason = !req.user ? 'Sign in to confirm your age to watch this 18+ video.'
      : req.user.restricted_mode ? 'This 18+ video is hidden while Restricted Mode is on.'
      : !req.user.birth_year ? 'Add your date of birth to watch age-restricted videos.'
      : 'This video is restricted to viewers 18 and older.';
    return res.status(451).json({ error: reason, age_restricted: true });
  }
  const dec = decorateVideo(v, req.user?.id);
  dec.subscribers = db.prepare('SELECT COUNT(*) c FROM subscriptions WHERE channel_id=?').get(v.user_id).c;
  dec.subscribed = req.user
    ? !!db.prepare('SELECT 1 FROM subscriptions WHERE subscriber_id=? AND channel_id=?').get(req.user.id, v.user_id)
    : false;
  dec.in_watch_later = req.user
    ? !!db.prepare('SELECT 1 FROM watch_later WHERE user_id=? AND video_id=?').get(req.user.id, v.id)
    : false;
  dec.cards = enrichCards(dec.cards);
  // End screen: a couple of suggested videos from the same channel (fallback to anything).
  if (dec.end_screen && !dec.is_premiere) {
    let sugg = db.prepare(`SELECT * FROM videos WHERE user_id=? AND id!=? AND ${LISTED_SQL} ORDER BY views DESC LIMIT 2`).all(v.user_id, v.id, Date.now());
    if (sugg.length < 2) sugg = sugg.concat(db.prepare(`SELECT * FROM videos WHERE id!=? AND user_id!=? AND ${LISTED_SQL} ORDER BY views DESC LIMIT ?`).all(v.id, v.user_id, Date.now(), 2 - sugg.length));
    dec.end_screen_videos = sugg.map(s => decorateVideo(s, req.user?.id));
  }
  dec.is_member = isChannelMember(req.user?.id, v.user_id);
  dec.channel_emoji = db.prepare('SELECT code, symbol FROM channel_emoji WHERE channel_id=? ORDER BY id').all(v.user_id);
  res.json({ video: dec });
});

// Serve a video's WebVTT captions for the <track> element.
app.get('/api/videos/:id/captions.vtt', (req, res) => {
  const v = db.prepare('SELECT captions FROM videos WHERE id=?').get(Number(req.params.id));
  if (!v || !v.captions) return res.status(404).send('No captions.');
  res.type('text/vtt').send(v.captions);
});

app.post('/api/videos', auth, limit('upload', 8, 300e3), uploadFields, (req, res) => {
  const videoFile = req.files?.video?.[0];
  const thumbFile = req.files?.thumbnail?.[0];
  const cleanup = () => { for (const f of [videoFile, thumbFile]) if (f) fs.unlink(f.path, () => {}); };

  if (!req.user.email_verified) { cleanup(); return res.status(403).json({ error: 'Please verify your email before uploading.' }); }
  if (!videoFile) { cleanup(); return res.status(400).json({ error: 'A video file is required.' }); }
  const title = String(req.body.title || '').trim();
  if (!title) { cleanup(); return res.status(400).json({ error: 'Title is required.' }); }

  const visibility = VISIBILITIES.includes(req.body.visibility) ? req.body.visibility : 'public';
  const publishAt = Number(req.body.publish_at) || null;   // ms epoch; future = scheduled
  const description = String(req.body.description || '').trim();
  const tags = parseTags(req.body.tags, description);
  const ageRestricted = req.body.age_restricted === 'true' || req.body.age_restricted === '1' ? 1 : 0;
  const membersOnly = req.body.members_only === 'true' || req.body.members_only === '1' ? 1 : 0;
  const isShort = req.body.is_short === 'true' || req.body.is_short === '1' ? 1 : 0;
  const premiereAt = Number(req.body.premiere_at) > Date.now() ? Number(req.body.premiere_at) : null;
  const endScreen = (req.body.end_screen === 'false' || req.body.end_screen === '0') ? 0 : 1;
  const captions = normaliseVtt(req.body.captions);
  const chapters = JSON.stringify(parseChapters(description));

  // Content fingerprint — flags exact duplicates re-uploaded by a different user (lightweight Content ID).
  let fingerprint = null;
  try { fingerprint = hashFileSync(videoFile.path); } catch { /* ignore */ }
  const dupeOwner = fingerprint && db.prepare('SELECT user_id, video_id FROM content_fingerprints WHERE fingerprint=? LIMIT 1').get(fingerprint);

  const info = db.prepare(
    `INSERT INTO videos (user_id, title, description, category, filename, thumbnail, duration, visibility, publish_at, tags, age_restricted, members_only, is_short, captions, chapters, fingerprint, premiere_at, end_screen, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    req.user.id, title, description,
    String(req.body.category || 'Other'),
    videoFile.filename,
    thumbFile ? thumbFile.filename : null,
    Number(req.body.duration || 0),
    visibility, publishAt, tags, ageRestricted, membersOnly, isShort, captions, chapters, fingerprint, premiereAt, endScreen, Date.now()
  );
  const v = db.prepare('SELECT * FROM videos WHERE id=?').get(info.lastInsertRowid);
  if (fingerprint) {
    db.prepare('INSERT OR IGNORE INTO content_fingerprints (fingerprint, video_id, user_id, created_at) VALUES (?,?,?,?)')
      .run(fingerprint, v.id, req.user.id, Date.now());
    if (dupeOwner && dupeOwner.user_id !== req.user.id) {
      flagFraud('dupe_upload', req.user.id, v.id, `Matches video #${dupeOwner.video_id} by user #${dupeOwner.user_id}`);
      const orig = getUserById(dupeOwner.user_id);
      if (orig) notify(orig.id, 'copyright', `⚠️ A possible re-upload of your content was detected: “${title}”.`, 'watch', v.id);
    }
  }
  syncFts(v.id);
  // Server-side duration probe (ffmpeg) overrides the client estimate when available.
  const realDur = transcode.probeDuration(videoFile.path);
  if (realDur) db.prepare('UPDATE videos SET duration=? WHERE id=?').run(realDur, v.id);
  // Mirror originals to S3/CDN when configured (best-effort, non-blocking).
  store.mirror(videoFile.path, videoFile.filename, videoFile.mimetype);
  if (thumbFile) store.mirror(thumbFile.path, thumbFile.filename, thumbFile.mimetype);
  // Kick off HLS renditions in the background if enabled.
  transcode.transcodeHLS(videoFile.path, path.join(UPLOAD_DIR, 'hls', String(v.id)));
  // Notify subscribers — for a live video now, or a premiere announcement.
  if (visibility === 'public' && !(publishAt && publishAt > Date.now())) {
    const subs = db.prepare('SELECT subscriber_id FROM subscriptions WHERE channel_id=?').all(req.user.id);
    const msg = premiereAt
      ? `${req.user.channel_name} scheduled a premiere: “${title}” 🎬`
      : `${req.user.channel_name} posted “${title}”`;
    for (const s of subs) notify(s.subscriber_id, premiereAt ? 'premiere' : 'new_video', msg, 'watch', v.id);
  }
  res.json({ video: decorateVideo(v, req.user.id) });
});

// Edit an existing video's metadata (title, description, tags, category, visibility, schedule).
app.patch('/api/videos/:id', auth, (req, res) => {
  const v = db.prepare('SELECT * FROM videos WHERE id=?').get(Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'Video not found.' });
  if (v.user_id !== req.user.id) return res.status(403).json({ error: 'Not your video.' });
  const title = req.body.title !== undefined ? String(req.body.title).trim() : v.title;
  if (!title) return res.status(400).json({ error: 'Title cannot be empty.' });
  const description = req.body.description !== undefined ? String(req.body.description).trim() : v.description;
  const category = req.body.category !== undefined ? String(req.body.category) : v.category;
  const visibility = VISIBILITIES.includes(req.body.visibility) ? req.body.visibility : v.visibility;
  const publishAt = req.body.publish_at !== undefined ? (Number(req.body.publish_at) || null) : v.publish_at;
  const tags = req.body.tags !== undefined ? parseTags(req.body.tags, description) : v.tags;
  const ageR = req.body.age_restricted !== undefined ? (req.body.age_restricted ? 1 : 0) : v.age_restricted;
  const membersOnly = req.body.members_only !== undefined ? (req.body.members_only ? 1 : 0) : v.members_only;
  const captions = req.body.captions !== undefined ? normaliseVtt(req.body.captions) : v.captions;
  const chapters = req.body.description !== undefined ? JSON.stringify(parseChapters(description)) : v.chapters;
  const cards = req.body.cards !== undefined ? parseCards(req.body.cards) : v.cards;
  const endScreen = req.body.end_screen !== undefined ? (req.body.end_screen ? 1 : 0) : v.end_screen;
  const premiereAt = req.body.premiere_at !== undefined ? (Number(req.body.premiere_at) > Date.now() ? Number(req.body.premiere_at) : null) : v.premiere_at;
  db.prepare('UPDATE videos SET title=?, description=?, category=?, visibility=?, publish_at=?, tags=?, age_restricted=?, members_only=?, captions=?, chapters=?, cards=?, end_screen=?, premiere_at=? WHERE id=?')
    .run(title, description, category, visibility, publishAt, tags, ageR, membersOnly, captions, chapters, cards, endScreen, premiereAt, v.id);
  syncFts(v.id);
  res.json({ video: decorateVideo(db.prepare('SELECT * FROM videos WHERE id=?').get(v.id), req.user.id) });
});

app.delete('/api/videos/:id', auth, (req, res) => {
  const v = db.prepare('SELECT * FROM videos WHERE id=?').get(Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'Video not found.' });
  if (v.user_id !== req.user.id) return res.status(403).json({ error: 'Not your video.' });
  fs.unlink(path.join(UPLOAD_DIR, v.filename), () => {});
  if (v.thumbnail) fs.unlink(path.join(UPLOAD_DIR, v.thumbnail), () => {});
  store.remove(v.filename); if (v.thumbnail) store.remove(v.thumbnail); // clean up S3 too
  db.prepare('DELETE FROM videos WHERE id=?').run(v.id);
  db.prepare('DELETE FROM videos_fts WHERE rowid=?').run(v.id);
  res.json({ ok: true });
});

// Award coins to a video owner and keep both counters in sync.
function creditOwner(video, coins) {
  db.prepare('UPDATE videos SET coins_earned = coins_earned + ? WHERE id=?').run(coins, video.id);
  db.prepare('UPDATE users SET coins = coins + ? WHERE id=?').run(coins, video.user_id);
}
// Reward a viewer for watching (their 10% share of the ad revenue).
function creditViewer(userId, coins) {
  db.prepare('UPDATE users SET coins = coins + ? WHERE id=?').run(coins, userId);
}

// Custom channel emoji: replace :codes: with the channel's symbols when rendering chat/comments.
function emojiMapFor(channelId) {
  const rows = db.prepare('SELECT code, symbol FROM channel_emoji WHERE channel_id=?').all(channelId);
  return Object.fromEntries(rows.map(r => [r.code, r.symbol]));
}
function renderEmoji(text, map) {
  if (!text || !Object.keys(map).length) return text;
  return text.replace(/:[a-z0-9_+-]{1,30}:/gi, m => map[m.toLowerCase()] || m);
}

const TRAFFIC_SOURCES = ['Home', 'Search', 'Trending', 'Suggested', 'Channel', 'Subscriptions', 'Share', 'Shorts', 'Direct'];
function logEvent(video, kind, seconds, source, country) {
  const src = TRAFFIC_SOURCES.includes(source) ? source : 'Direct';
  db.prepare('INSERT INTO analytics_events (owner_id, video_id, kind, seconds, source, country, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(video.user_id, video.id, kind, seconds || 0, kind === 'view' ? src : null, country || null, Date.now());
}
// Coarse country: real CDN header if present, else derived from Accept-Language.
function countryOf(req) {
  const cf = req.headers['cf-ipcountry'];
  if (cf && cf !== 'XX') return String(cf).toUpperCase();
  const al = String(req.headers['accept-language'] || '').split(',')[0]; // e.g. en-US
  const m = al.match(/-([A-Za-z]{2})/);
  return m ? m[1].toUpperCase() : null;
}

// A view is an engagement metric only — it does NOT pay. Earnings come from ads.
app.post('/api/videos/:id/view', optionalAuth, (req, res) => {
  const v = db.prepare('SELECT * FROM videos WHERE id=?').get(Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'Video not found.' });
  // View-fraud guard: cap counted views per actor per video; beyond that, flag & don't count.
  const vr = rateLimit(actorOf(req), 'view:' + v.id, 20, 60e3);
  if (!vr.allowed) {
    // Flag once per actor+video per hour, not on every blocked view.
    const recent = db.prepare("SELECT 1 FROM fraud_flags WHERE kind='view_fraud' AND ref_video=? AND detail LIKE ? AND created_at > ?")
      .get(v.id, actorOf(req) + '%', Date.now() - 3600e3);
    if (!recent) flagFraud('view_fraud', req.user?.id || null, v.id, `${actorOf(req)} exceeded 20 views/min`);
    return res.json({ views: v.views, counted: false });
  }
  db.prepare('UPDATE videos SET views = views + 1 WHERE id=?').run(v.id);
  logEvent(v, 'view', 0, req.body.source, countryOf(req)); // analytics: view + traffic source + geography
  // Record it in the viewer's watch history.
  if (req.user) {
    db.prepare(`INSERT INTO watch_history (user_id, video_id, watched_at) VALUES (?,?,?)
                ON CONFLICT(user_id, video_id) DO UPDATE SET watched_at=excluded.watched_at`)
      .run(req.user.id, v.id, Date.now());
  }
  const views = db.prepare('SELECT views FROM videos WHERE id=?').get(v.id).views;
  res.json({ views });
});

// An ad impression = real ad revenue, split between the creator and the owner.
// Throttled to one paid ad view per viewer per video per window.
app.post('/api/videos/:id/ad', optionalAuth, (req, res) => {
  const v = db.prepare('SELECT * FROM videos WHERE id=?').get(Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'Video not found.' });
  const viewer = req.user ? 'u:' + req.user.id : 'anon:' + req.ip;
  const now = Date.now();
  const prev = db.prepare('SELECT last_ts FROM ad_events WHERE video_id=? AND viewer=?').get(v.id, viewer);
  if (prev && now - prev.last_ts < eco.AD_THROTTLE_MS) return res.json({ awarded: 0 });
  db.prepare(`INSERT INTO ad_events (video_id, viewer, last_ts) VALUES (?,?,?)
              ON CONFLICT(video_id, viewer) DO UPDATE SET last_ts=excluded.last_ts`).run(v.id, viewer, now);
  const split = eco.adSplit();
  const creatorUser = getUserById(v.user_id);
  if (creatorUser && creatorUser.monetization_enabled) {
    // Monetized creator: split ad revenue three ways — creator 70%, viewer 10%, owner 20%.
    creditOwner(v, split.creator);
    creditOwnerAccount(split.owner);
    creditPlatform('ad_commission', split.owner, v.user_id, v.id);
    logEvent(v, 'revenue', split.creator); // creator's coin revenue for the revenue report
    // Watch-to-earn: reward the signed-in viewer, unless they're the creator
    // watching their own video. With no eligible viewer, that share falls to the platform.
    let viewerAward = 0;
    if (req.user && req.user.id !== v.user_id) {
      creditViewer(req.user.id, split.viewer);
      viewerAward = split.viewer;
    } else {
      creditOwnerAccount(split.viewer);
      creditPlatform('ad_platform', split.viewer, v.user_id, v.id);
    }
    res.json({ awarded: split.creator, owner_cut: split.owner, viewer_award: viewerAward, monetized: true });
  } else {
    // Not yet monetized: ads still run, but the platform keeps the full revenue.
    creditOwnerAccount(split.total);
    creditPlatform('ad_platform', split.total, v.user_id, v.id);
    res.json({ awarded: 0, owner_cut: split.total, monetized: false });
  }
});

// Watch-time is an engagement metric only — logged for analytics, no payout.
app.post('/api/videos/:id/watch', optionalAuth, (req, res) => {
  const v = db.prepare('SELECT * FROM videos WHERE id=?').get(Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'Video not found.' });
  const seconds = Math.max(0, Math.min(600, Number(req.body.seconds) || 0)); // cap per call
  if (seconds > 0) logEvent(v, 'watch', seconds); // analytics: watch-time
  res.json({ awarded: 0 });
});

app.post('/api/videos/:id/like', auth, (req, res) => {
  const v = db.prepare('SELECT * FROM videos WHERE id=?').get(Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'Video not found.' });
  const existing = db.prepare('SELECT 1 FROM video_likes WHERE user_id=? AND video_id=?').get(req.user.id, v.id);
  let liked;
  if (existing) {
    db.prepare('DELETE FROM video_likes WHERE user_id=? AND video_id=?').run(req.user.id, v.id);
    db.prepare('UPDATE videos SET likes = likes - 1 WHERE id=?').run(v.id);
    liked = false;
  } else {
    db.prepare('INSERT INTO video_likes (user_id, video_id) VALUES (?,?)').run(req.user.id, v.id);
    db.prepare('UPDATE videos SET likes = likes + 1 WHERE id=?').run(v.id);
    // A like clears any existing dislike (as on YouTube).
    if (db.prepare('SELECT 1 FROM video_dislikes WHERE user_id=? AND video_id=?').get(req.user.id, v.id)) {
      db.prepare('DELETE FROM video_dislikes WHERE user_id=? AND video_id=?').run(req.user.id, v.id);
      db.prepare('UPDATE videos SET dislikes = dislikes - 1 WHERE id=?').run(v.id);
    }
    liked = true;
  }
  const row = db.prepare('SELECT likes, dislikes FROM videos WHERE id=?').get(v.id);
  res.json({ liked, likes: row.likes, dislikes: row.dislikes, disliked: false });
});

app.post('/api/videos/:id/dislike', auth, (req, res) => {
  const v = db.prepare('SELECT * FROM videos WHERE id=?').get(Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'Video not found.' });
  const existing = db.prepare('SELECT 1 FROM video_dislikes WHERE user_id=? AND video_id=?').get(req.user.id, v.id);
  let disliked;
  if (existing) {
    db.prepare('DELETE FROM video_dislikes WHERE user_id=? AND video_id=?').run(req.user.id, v.id);
    db.prepare('UPDATE videos SET dislikes = dislikes - 1 WHERE id=?').run(v.id);
    disliked = false;
  } else {
    db.prepare('INSERT INTO video_dislikes (user_id, video_id) VALUES (?,?)').run(req.user.id, v.id);
    db.prepare('UPDATE videos SET dislikes = dislikes + 1 WHERE id=?').run(v.id);
    // A dislike clears any existing like.
    if (db.prepare('SELECT 1 FROM video_likes WHERE user_id=? AND video_id=?').get(req.user.id, v.id)) {
      db.prepare('DELETE FROM video_likes WHERE user_id=? AND video_id=?').run(req.user.id, v.id);
      db.prepare('UPDATE videos SET likes = likes - 1 WHERE id=?').run(v.id);
    }
    disliked = true;
  }
  const row = db.prepare('SELECT likes, dislikes FROM videos WHERE id=?').get(v.id);
  res.json({ disliked, likes: row.likes, dislikes: row.dislikes, liked: false });
});

/* ----------------------------- watch history & Watch Later ----------------------------- */
app.get('/api/history', auth, (req, res) => {
  const rows = db.prepare(
    `SELECT v.*, h.watched_at FROM watch_history h JOIN videos v ON v.id=h.video_id
     WHERE h.user_id=? AND v.removed=0 ORDER BY h.watched_at DESC LIMIT 100`).all(req.user.id);
  res.json({ videos: rows.map(v => decorateVideo(v, req.user.id)) });
});
app.delete('/api/history', auth, (req, res) => {
  db.prepare('DELETE FROM watch_history WHERE user_id=?').run(req.user.id);
  res.json({ ok: true });
});
app.delete('/api/history/:videoId', auth, (req, res) => {
  db.prepare('DELETE FROM watch_history WHERE user_id=? AND video_id=?').run(req.user.id, Number(req.params.videoId));
  res.json({ ok: true });
});

app.get('/api/watch-later', auth, (req, res) => {
  const rows = db.prepare(
    `SELECT v.* FROM watch_later w JOIN videos v ON v.id=w.video_id
     WHERE w.user_id=? AND v.removed=0 ORDER BY w.added_at DESC`).all(req.user.id);
  res.json({ videos: rows.map(v => decorateVideo(v, req.user.id)) });
});
app.post('/api/watch-later', auth, (req, res) => {
  const videoId = Number(req.body.video_id);
  if (!db.prepare('SELECT 1 FROM videos WHERE id=?').get(videoId)) return res.status(404).json({ error: 'Video not found.' });
  const exists = db.prepare('SELECT 1 FROM watch_later WHERE user_id=? AND video_id=?').get(req.user.id, videoId);
  if (exists) {
    db.prepare('DELETE FROM watch_later WHERE user_id=? AND video_id=?').run(req.user.id, videoId);
    return res.json({ saved: false });
  }
  db.prepare('INSERT INTO watch_later (user_id, video_id, added_at) VALUES (?,?,?)').run(req.user.id, videoId, Date.now());
  res.json({ saved: true });
});
app.delete('/api/watch-later/:videoId', auth, (req, res) => {
  db.prepare('DELETE FROM watch_later WHERE user_id=? AND video_id=?').run(req.user.id, Number(req.params.videoId));
  res.json({ ok: true });
});

/* ----------------------------- comments (threaded) ----------------------------- */
// Top-level comments sorted pinned-first, then by likes ("Top comments"), with replies nested.
app.get('/api/videos/:id/comments', optionalAuth, (req, res) => {
  const videoId = Number(req.params.id);
  const uid = req.user?.id;
  const rows = db.prepare(
    `SELECT c.id, c.body, c.created_at, c.parent_id, c.likes, c.pinned, c.hearted,
            u.channel_name, u.avatar_color, u.id AS user_id
     FROM comments c JOIN users u ON u.id = c.user_id
     WHERE c.video_id = ?`).all(videoId);
  const likedIds = uid
    ? new Set(db.prepare('SELECT comment_id FROM comment_likes WHERE user_id=?').all(uid).map(r => r.comment_id))
    : new Set();
  const videoOwner = db.prepare('SELECT user_id FROM videos WHERE id=?').get(videoId)?.user_id;
  const emojis = emojiMapFor(videoOwner);

  const byId = new Map();
  for (const c of rows) {
    c.liked = likedIds.has(c.id);
    c.is_creator = c.user_id === videoOwner;
    c.member_badge = memberBadge(c.user_id, videoOwner);   // member tier badge for this channel
    c.body = renderEmoji(c.body, emojis);                   // channel custom emoji
    c.replies = []; byId.set(c.id, c);
  }
  const top = [];
  for (const c of rows) {
    if (c.parent_id && byId.has(c.parent_id)) byId.get(c.parent_id).replies.push(c);
    else if (!c.parent_id) top.push(c);
  }
  top.sort((a, b) => (b.pinned - a.pinned) || (b.likes - a.likes) || (b.created_at - a.created_at));
  for (const c of top) c.replies.sort((a, b) => a.created_at - b.created_at);
  res.json({ comments: top, total: rows.length, can_moderate: uid === videoOwner });
});

app.post('/api/videos/:id/comments', auth, limit('comment', 12, 60e3), (req, res) => {
  const v = db.prepare('SELECT id, user_id FROM videos WHERE id=?').get(Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'Video not found.' });
  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Comment cannot be empty.' });

  // Replies attach to a top-level comment only (one level deep, like YouTube).
  let parentId = Number(req.body.parent_id) || null;
  if (parentId) {
    const parent = db.prepare('SELECT id, parent_id, user_id FROM comments WHERE id=? AND video_id=?').get(parentId, v.id);
    if (!parent) return res.status(404).json({ error: 'That comment no longer exists.' });
    if (parent.parent_id) parentId = parent.parent_id; // flatten nested replies
    if (parent.user_id !== req.user.id) notify(parent.user_id, 'comment', `${req.user.channel_name} replied to your comment`, 'watch', v.id);
  }
  const info = db.prepare('INSERT INTO comments (video_id, user_id, body, parent_id, created_at) VALUES (?,?,?,?,?)')
    .run(v.id, req.user.id, body.slice(0, 1000), parentId, Date.now());
  if (v.user_id !== req.user.id && !parentId) notify(v.user_id, 'comment', `${req.user.channel_name} commented on your video`, 'watch', v.id);
  res.json({
    comment: {
      id: info.lastInsertRowid, body, created_at: Date.now(), parent_id: parentId,
      likes: 0, liked: false, pinned: 0, hearted: 0, replies: [],
      channel_name: req.user.channel_name, avatar_color: req.user.avatar_color, user_id: req.user.id,
    },
  });
});

app.post('/api/comments/:id/like', auth, (req, res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id=?').get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Comment not found.' });
  const existing = db.prepare('SELECT 1 FROM comment_likes WHERE user_id=? AND comment_id=?').get(req.user.id, c.id);
  if (existing) {
    db.prepare('DELETE FROM comment_likes WHERE user_id=? AND comment_id=?').run(req.user.id, c.id);
    db.prepare('UPDATE comments SET likes = likes - 1 WHERE id=?').run(c.id);
  } else {
    db.prepare('INSERT INTO comment_likes (user_id, comment_id) VALUES (?,?)').run(req.user.id, c.id);
    db.prepare('UPDATE comments SET likes = likes + 1 WHERE id=?').run(c.id);
  }
  const likes = db.prepare('SELECT likes FROM comments WHERE id=?').get(c.id).likes;
  res.json({ liked: !existing, likes });
});

// Pin (one per video) and heart — video creator only.
function requireVideoOwner(req, res, c) {
  const owner = db.prepare('SELECT user_id FROM videos WHERE id=?').get(c.video_id)?.user_id;
  if (owner !== req.user.id) { res.status(403).json({ error: 'Only the creator can do that.' }); return false; }
  return true;
}
app.post('/api/comments/:id/pin', auth, (req, res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id=?').get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Comment not found.' });
  if (!requireVideoOwner(req, res, c)) return;
  if (c.parent_id) return res.status(400).json({ error: 'Only top-level comments can be pinned.' });
  const nowPinned = !c.pinned;
  db.prepare('UPDATE comments SET pinned=0 WHERE video_id=?').run(c.video_id); // only one pinned
  if (nowPinned) db.prepare('UPDATE comments SET pinned=1 WHERE id=?').run(c.id);
  res.json({ pinned: nowPinned });
});
app.post('/api/comments/:id/heart', auth, (req, res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id=?').get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Comment not found.' });
  if (!requireVideoOwner(req, res, c)) return;
  const hearted = c.hearted ? 0 : 1;
  db.prepare('UPDATE comments SET hearted=? WHERE id=?').run(hearted, c.id);
  if (hearted && c.user_id !== req.user.id) notify(c.user_id, 'comment', `${req.user.channel_name} ❤ your comment`, 'watch', c.video_id);
  res.json({ hearted: !!hearted });
});

// Author OR the video's creator can delete. Deleting a top-level comment removes its replies.
app.delete('/api/comments/:id', auth, (req, res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id=?').get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Comment not found.' });
  const videoOwner = db.prepare('SELECT user_id FROM videos WHERE id=?').get(c.video_id)?.user_id;
  if (c.user_id !== req.user.id && videoOwner !== req.user.id)
    return res.status(403).json({ error: 'You can only delete your own comments.' });
  db.prepare('DELETE FROM comments WHERE id=? OR parent_id=?').run(c.id, c.id);
  res.json({ ok: true });
});

/* ----------------------------- channel profile & customization ----------------------------- */
app.get('/api/channels/:id', optionalAuth, (req, res) => {
  const u = getUserById(Number(req.params.id));
  if (!u) return res.status(404).json({ error: 'Channel not found.' });
  const subscribers = db.prepare('SELECT COUNT(*) c FROM subscriptions WHERE channel_id=?').get(u.id).c;
  const videoCount = db.prepare(`SELECT COUNT(*) c FROM videos WHERE user_id=? AND ${LISTED_SQL}`).get(u.id, Date.now()).c;
  const subscribed = req.user ? !!db.prepare('SELECT 1 FROM subscriptions WHERE subscriber_id=? AND channel_id=?').get(req.user.id, u.id) : false;
  let links = []; try { links = JSON.parse(u.links || '[]'); } catch { links = []; }
  const trailer = u.trailer_id ? db.prepare(`SELECT * FROM videos WHERE id=? AND user_id=? AND ${LISTED_SQL}`).get(u.trailer_id, u.id, Date.now()) : null;
  res.json({
    channel: {
      id: u.id, channel_name: u.channel_name, avatar_color: u.avatar_color,
      avatar_url: u.avatar_img ? store.urlFor(u.avatar_img) : null,
      banner_url: u.banner ? store.urlFor(u.banner) : null,
      about: u.about || '', links, subscribers, video_count: videoCount, subscribed,
      is_owner: req.user && req.user.id === u.id,
      // Show the trailer to non-subscribers (like YouTube).
      trailer: (trailer && !subscribed && (!req.user || req.user.id !== u.id)) ? decorateVideo(trailer, req.user?.id) : null,
    },
  });
});

const brandingUpload = upload.fields([{ name: 'banner', maxCount: 1 }, { name: 'avatar', maxCount: 1 }]);
app.put('/api/channel/branding', auth, brandingUpload, (req, res) => {
  const banner = req.files?.banner?.[0];
  const avatar = req.files?.avatar?.[0];
  if (banner) {
    const old = req.user.banner;
    db.prepare('UPDATE users SET banner=? WHERE id=?').run(banner.filename, req.user.id);
    store.mirror(banner.path, banner.filename, banner.mimetype);
    if (old) fs.unlink(path.join(UPLOAD_DIR, old), () => {});
  }
  if (avatar) {
    const old = req.user.avatar_img;
    db.prepare('UPDATE users SET avatar_img=? WHERE id=?').run(avatar.filename, req.user.id);
    store.mirror(avatar.path, avatar.filename, avatar.mimetype);
    if (old) fs.unlink(path.join(UPLOAD_DIR, old), () => {});
  }
  res.json({ user: publicUser(getUserById(req.user.id)) });
});

app.put('/api/channel/about', auth, (req, res) => {
  const about = String(req.body.about || '').slice(0, 2000);
  let links = [];
  if (Array.isArray(req.body.links)) {
    links = req.body.links.map(l => ({ label: String(l.label || '').slice(0, 40), url: String(l.url || '').trim() }))
      .filter(l => l.label && /^https?:\/\//i.test(l.url)).slice(0, 8);
  }
  let trailerId = req.body.trailer_id != null ? Number(req.body.trailer_id) || null : req.user.trailer_id;
  if (trailerId) {
    const v = db.prepare('SELECT user_id FROM videos WHERE id=?').get(trailerId);
    if (!v || v.user_id !== req.user.id) trailerId = null; // must be your own video
  }
  db.prepare('UPDATE users SET about=?, links=?, trailer_id=? WHERE id=?')
    .run(about, JSON.stringify(links), trailerId, req.user.id);
  res.json({ ok: true });
});

/* ----------------------------- subscriptions ----------------------------- */
app.post('/api/channels/:id/subscribe', auth, (req, res) => {
  const channelId = Number(req.params.id);
  if (channelId === req.user.id) return res.status(400).json({ error: "You can't subscribe to yourself." });
  if (!getUserById(channelId)) return res.status(404).json({ error: 'Channel not found.' });
  const existing = db.prepare('SELECT 1 FROM subscriptions WHERE subscriber_id=? AND channel_id=?').get(req.user.id, channelId);
  let subscribed;
  if (existing) {
    db.prepare('DELETE FROM subscriptions WHERE subscriber_id=? AND channel_id=?').run(req.user.id, channelId);
    subscribed = false;
  } else {
    db.prepare('INSERT INTO subscriptions (subscriber_id, channel_id, created_at) VALUES (?,?,?)').run(req.user.id, channelId, Date.now());
    subscribed = true;
    notify(channelId, 'subscribe', `${req.user.channel_name} subscribed to your channel`, 'channel', req.user.id);
    // If this subscribe just made the channel monetization-eligible, tell them once.
    const ch = getUserById(channelId);
    if (!ch.monetization_enabled && !ch.monetization_notified && monetizationStatus(channelId).eligible) {
      db.prepare('UPDATE users SET monetization_notified=1 WHERE id=?').run(channelId);
      notify(channelId, 'monetization', '🎉 You now qualify for monetization! Enable it in Creator Studio to earn from ads.', 'studio');
    }
  }
  const subscribers = db.prepare('SELECT COUNT(*) c FROM subscriptions WHERE channel_id=?').get(channelId).c;
  res.json({ subscribed, subscribers });
});

app.get('/api/subscriptions', auth, (req, res) => {
  const rows = db.prepare(
    `SELECT u.id, u.channel_name, u.avatar_color,
            (SELECT COUNT(*) FROM subscriptions s2 WHERE s2.channel_id=u.id) AS subscribers
     FROM subscriptions s JOIN users u ON u.id = s.channel_id
     WHERE s.subscriber_id = ? ORDER BY s.created_at DESC`
  ).all(req.user.id);
  res.json({ channels: rows });
});

/* ----------------------------- community posts + polls ----------------------------- */
function shapePost(p, uid) {
  const author = getUserById(p.user_id);
  const emojis = emojiMapFor(p.user_id);
  // Members-only posts are locked for non-members (and non-creator).
  const locked = p.members_only && !isChannelMember(uid, p.user_id);
  const options = locked ? [] : db.prepare('SELECT id, text, votes FROM poll_options WHERE post_id=? ORDER BY id').all(p.id);
  const myVote = uid && !locked ? db.prepare('SELECT option_id FROM poll_votes WHERE user_id=? AND post_id=?').get(uid, p.id) : null;
  return {
    id: p.id, created_at: p.created_at, members_only: !!p.members_only, locked,
    body: locked ? null : renderEmoji(p.body, emojis),
    likes: p.likes, channel_id: p.user_id, channel_name: author?.channel_name, avatar_color: author?.avatar_color,
    liked: uid && !locked ? !!db.prepare('SELECT 1 FROM post_likes WHERE user_id=? AND post_id=?').get(uid, p.id) : false,
    poll: options.length ? { options, total_votes: options.reduce((s, o) => s + o.votes, 0), my_vote: myVote?.option_id || null } : null,
  };
}
app.get('/api/channels/:id/posts', optionalAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM community_posts WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(Number(req.params.id));
  res.json({ posts: rows.map(p => shapePost(p, req.user?.id)) });
});
app.post('/api/channels/:id/posts', auth, (req, res) => {
  if (Number(req.params.id) !== req.user.id) return res.status(403).json({ error: 'You can only post to your own channel.' });
  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Write something to post.' });
  const membersOnly = req.body.members_only ? 1 : 0;
  const opts = Array.isArray(req.body.poll_options)
    ? req.body.poll_options.map(o => String(o).trim()).filter(Boolean).slice(0, 5) : [];
  if (opts.length === 1) return res.status(400).json({ error: 'A poll needs at least two options.' });
  const info = db.prepare('INSERT INTO community_posts (user_id, body, members_only, created_at) VALUES (?,?,?,?)')
    .run(req.user.id, body.slice(0, 1000), membersOnly, Date.now());
  for (const o of opts) db.prepare('INSERT INTO poll_options (post_id, text) VALUES (?,?)').run(info.lastInsertRowid, o.slice(0, 100));
  // Tell subscribers there's a new post.
  for (const s of db.prepare('SELECT subscriber_id FROM subscriptions WHERE channel_id=?').all(req.user.id))
    notify(s.subscriber_id, 'post', `${req.user.channel_name} shared a community post`, 'channel', req.user.id);
  res.json({ post: shapePost(db.prepare('SELECT * FROM community_posts WHERE id=?').get(info.lastInsertRowid), req.user.id) });
});
app.post('/api/posts/:id/like', auth, (req, res) => {
  const p = db.prepare('SELECT * FROM community_posts WHERE id=?').get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Post not found.' });
  const existing = db.prepare('SELECT 1 FROM post_likes WHERE user_id=? AND post_id=?').get(req.user.id, p.id);
  if (existing) {
    db.prepare('DELETE FROM post_likes WHERE user_id=? AND post_id=?').run(req.user.id, p.id);
    db.prepare('UPDATE community_posts SET likes = likes - 1 WHERE id=?').run(p.id);
  } else {
    db.prepare('INSERT INTO post_likes (user_id, post_id) VALUES (?,?)').run(req.user.id, p.id);
    db.prepare('UPDATE community_posts SET likes = likes + 1 WHERE id=?').run(p.id);
  }
  res.json({ liked: !existing, likes: db.prepare('SELECT likes FROM community_posts WHERE id=?').get(p.id).likes });
});
app.post('/api/posts/:id/vote', auth, (req, res) => {
  const p = db.prepare('SELECT * FROM community_posts WHERE id=?').get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Post not found.' });
  const optionId = Number(req.body.option_id);
  const opt = db.prepare('SELECT * FROM poll_options WHERE id=? AND post_id=?').get(optionId, p.id);
  if (!opt) return res.status(400).json({ error: 'Pick a valid option.' });
  const prev = db.prepare('SELECT option_id FROM poll_votes WHERE user_id=? AND post_id=?').get(req.user.id, p.id);
  if (prev) {
    if (prev.option_id === optionId) return res.json({ post: shapePost(p, req.user.id) }); // no change
    db.prepare('UPDATE poll_options SET votes = votes - 1 WHERE id=?').run(prev.option_id);
    db.prepare('UPDATE poll_votes SET option_id=? WHERE user_id=? AND post_id=?').run(optionId, req.user.id, p.id);
  } else {
    db.prepare('INSERT INTO poll_votes (user_id, post_id, option_id) VALUES (?,?,?)').run(req.user.id, p.id, optionId);
  }
  db.prepare('UPDATE poll_options SET votes = votes + 1 WHERE id=?').run(optionId);
  res.json({ post: shapePost(p, req.user.id) });
});
app.delete('/api/posts/:id', auth, (req, res) => {
  const p = db.prepare('SELECT * FROM community_posts WHERE id=?').get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Post not found.' });
  if (p.user_id !== req.user.id) return res.status(403).json({ error: 'Not your post.' });
  db.prepare('DELETE FROM community_posts WHERE id=?').run(p.id);
  res.json({ ok: true });
});

/* ----------------------------- channel memberships ----------------------------- */
const MEMBERSHIP_DAYS = 30;
function membershipOf(uid, channelId) {
  if (!uid) return null;
  return db.prepare('SELECT * FROM memberships WHERE user_id=? AND channel_id=? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1')
    .get(uid, channelId, Date.now());
}
function isChannelMember(uid, channelId) {
  return uid === channelId || !!membershipOf(uid, channelId); // the creator counts as a member of their own channel
}
// Member badge for showing next to a commenter/chatter in a channel context.
function memberBadge(uid, channelId) {
  if (!uid || uid === channelId) return null;
  const m = db.prepare(
    `SELECT t.name FROM memberships m JOIN membership_tiers t ON t.id=m.tier_id
     WHERE m.user_id=? AND m.channel_id=? AND m.expires_at > ? ORDER BY m.expires_at DESC LIMIT 1`).get(uid, channelId, Date.now());
  return m ? m.name : null;
}
app.get('/api/channels/:id/tiers', optionalAuth, (req, res) => {
  const channelId = Number(req.params.id);
  const tiers = db.prepare('SELECT * FROM membership_tiers WHERE channel_id=? ORDER BY price_coins').all(channelId);
  for (const t of tiers) t.members = db.prepare('SELECT COUNT(*) c FROM memberships WHERE tier_id=? AND expires_at > ?').get(t.id, Date.now()).c;
  const mine = membershipOf(req.user?.id, channelId);
  res.json({ tiers, membership: mine ? { tier_id: mine.tier_id, expires_at: mine.expires_at } : null });
});
app.post('/api/channels/:id/tiers', auth, (req, res) => {
  if (Number(req.params.id) !== req.user.id) return res.status(403).json({ error: 'You can only add tiers to your own channel.' });
  const name = String(req.body.name || '').trim();
  const price = Math.floor(Number(req.body.price_coins) || 0);
  if (!name) return res.status(400).json({ error: 'Give the tier a name.' });
  if (price <= 0) return res.status(400).json({ error: 'Set a price above 0 coins.' });
  const info = db.prepare('INSERT INTO membership_tiers (channel_id, name, price_coins, perks, created_at) VALUES (?,?,?,?,?)')
    .run(req.user.id, name.slice(0, 60), price, String(req.body.perks || '').slice(0, 300), Date.now());
  res.json({ tier: db.prepare('SELECT * FROM membership_tiers WHERE id=?').get(info.lastInsertRowid) });
});
app.delete('/api/tiers/:id', auth, (req, res) => {
  const t = db.prepare('SELECT * FROM membership_tiers WHERE id=?').get(Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Tier not found.' });
  if (t.channel_id !== req.user.id) return res.status(403).json({ error: 'Not your tier.' });
  db.prepare('DELETE FROM membership_tiers WHERE id=?').run(t.id);
  res.json({ ok: true });
});
// Join a tier: coins move from the member to the creator; membership lasts 30 days.
app.post('/api/tiers/:id/join', auth, (req, res) => {
  const t = db.prepare('SELECT * FROM membership_tiers WHERE id=?').get(Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Tier not found.' });
  if (t.channel_id === req.user.id) return res.status(400).json({ error: "You can't join your own channel." });
  const me = getUserById(req.user.id);
  if (me.coins < t.price_coins) return res.status(400).json({ error: `Not enough coins. You have ${me.coins}, this tier costs ${t.price_coins}.` });
  if (membershipOf(req.user.id, t.channel_id)) return res.status(400).json({ error: 'You are already a member of this channel.' });

  db.prepare('UPDATE users SET coins = coins - ? WHERE id=?').run(t.price_coins, req.user.id);
  db.prepare('UPDATE users SET coins = coins + ? WHERE id=?').run(t.price_coins, t.channel_id);
  const now = Date.now(), expires = now + MEMBERSHIP_DAYS * 86400e3;
  db.prepare('INSERT INTO memberships (user_id, channel_id, tier_id, started_at, expires_at) VALUES (?,?,?,?,?)')
    .run(req.user.id, t.channel_id, t.id, now, expires);
  notify(t.channel_id, 'membership', `⭐ ${req.user.channel_name} joined your “${t.name}” membership`, 'channel', t.channel_id);
  res.json({ ok: true, balance: getUserById(req.user.id).coins, expires_at: expires });
});
app.get('/api/memberships', auth, (req, res) => {
  const rows = db.prepare(
    `SELECT m.expires_at, t.name AS tier_name, t.price_coins, u.id AS channel_id, u.channel_name, u.avatar_color
     FROM memberships m JOIN membership_tiers t ON t.id=m.tier_id JOIN users u ON u.id=m.channel_id
     WHERE m.user_id=? AND m.expires_at > ? ORDER BY m.expires_at DESC`).all(req.user.id, Date.now());
  res.json({ memberships: rows });
});

/* ----------------------------- custom channel emoji ----------------------------- */
app.get('/api/channels/:id/emoji', optionalAuth, (req, res) => {
  const channelId = Number(req.params.id);
  const list = db.prepare('SELECT id, code, symbol FROM channel_emoji WHERE channel_id=? ORDER BY id').all(channelId);
  res.json({ emoji: list, can_use: isChannelMember(req.user?.id, channelId) }); // members (and the creator) may use them
});
app.post('/api/channels/:id/emoji', auth, (req, res) => {
  if (Number(req.params.id) !== req.user.id) return res.status(403).json({ error: 'You can only add emoji to your own channel.' });
  let code = String(req.body.code || '').trim().toLowerCase().replace(/[^a-z0-9_+-]/g, '');
  const symbol = String(req.body.symbol || '').trim().slice(0, 8);
  if (!code || !symbol) return res.status(400).json({ error: 'Give the emoji a code and a symbol.' });
  code = ':' + code + ':';
  if (db.prepare('SELECT COUNT(*) c FROM channel_emoji WHERE channel_id=?').get(req.user.id).c >= 30)
    return res.status(400).json({ error: 'You can have at most 30 custom emoji.' });
  if (db.prepare('SELECT 1 FROM channel_emoji WHERE channel_id=? AND code=?').get(req.user.id, code))
    return res.status(409).json({ error: 'That code is already used.' });
  const info = db.prepare('INSERT INTO channel_emoji (channel_id, code, symbol, created_at) VALUES (?,?,?,?)')
    .run(req.user.id, code, symbol, Date.now());
  res.json({ item: db.prepare('SELECT id, code, symbol FROM channel_emoji WHERE id=?').get(info.lastInsertRowid) });
});
app.delete('/api/emoji/:id', auth, (req, res) => {
  const e = db.prepare('SELECT * FROM channel_emoji WHERE id=?').get(Number(req.params.id));
  if (!e) return res.status(404).json({ error: 'Emoji not found.' });
  if (e.channel_id !== req.user.id) return res.status(403).json({ error: 'Not your emoji.' });
  db.prepare('DELETE FROM channel_emoji WHERE id=?').run(e.id);
  res.json({ ok: true });
});

/* ----------------------------- merch shelf ----------------------------- */
app.get('/api/channels/:id/merch', (req, res) => {
  res.json({ merch: db.prepare('SELECT * FROM merch_items WHERE channel_id=? ORDER BY created_at DESC').all(Number(req.params.id)) });
});
app.post('/api/channels/:id/merch', auth, (req, res) => {
  if (Number(req.params.id) !== req.user.id) return res.status(403).json({ error: 'You can only add merch to your own channel.' });
  const title = String(req.body.title || '').trim();
  const price = String(req.body.price || '').trim();
  const url = String(req.body.url || '').trim();
  if (!title || !price || !url) return res.status(400).json({ error: 'Title, price and link are all required.' });
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'The link must start with http:// or https://' });
  const info = db.prepare('INSERT INTO merch_items (channel_id, title, price, url, created_at) VALUES (?,?,?,?,?)')
    .run(req.user.id, title.slice(0, 80), price.slice(0, 20), url.slice(0, 300), Date.now());
  res.json({ item: db.prepare('SELECT * FROM merch_items WHERE id=?').get(info.lastInsertRowid) });
});
app.delete('/api/merch/:id', auth, (req, res) => {
  const m = db.prepare('SELECT * FROM merch_items WHERE id=?').get(Number(req.params.id));
  if (!m) return res.status(404).json({ error: 'Item not found.' });
  if (m.channel_id !== req.user.id) return res.status(403).json({ error: 'Not your item.' });
  db.prepare('DELETE FROM merch_items WHERE id=?').run(m.id);
  res.json({ ok: true });
});

/* ----------------------------- creator analytics ----------------------------- */
app.get('/api/analytics', auth, (req, res) => {
  const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));
  const since = Date.now() - days * 86400e3;
  const owner = req.user.id;
  const dayExpr = "date(created_at/1000,'unixepoch')";

  const watchByDay = db.prepare(
    `SELECT ${dayExpr} d, SUM(seconds) s FROM analytics_events
     WHERE owner_id=? AND kind='watch' AND created_at>=? GROUP BY d`).all(owner, since);
  const viewsByDay = db.prepare(
    `SELECT ${dayExpr} d, COUNT(*) c FROM analytics_events
     WHERE owner_id=? AND kind='view' AND created_at>=? GROUP BY d`).all(owner, since);
  const sources = db.prepare(
    `SELECT COALESCE(source,'Direct') src, COUNT(*) c FROM analytics_events
     WHERE owner_id=? AND kind='view' AND created_at>=? GROUP BY src ORDER BY c DESC`).all(owner, since);
  const totalWatch = db.prepare(
    `SELECT COALESCE(SUM(seconds),0) s FROM analytics_events WHERE owner_id=? AND kind='watch' AND created_at>=?`).get(owner, since).s;
  const totalViews = db.prepare(
    `SELECT COUNT(*) c FROM analytics_events WHERE owner_id=? AND kind='view' AND created_at>=?`).get(owner, since).c;
  const topVideos = db.prepare(
    `SELECT v.id, v.title, COALESCE(SUM(e.seconds),0) secs,
            (SELECT COUNT(*) FROM analytics_events e2 WHERE e2.video_id=v.id AND e2.kind='view' AND e2.created_at>=?) views
     FROM analytics_events e JOIN videos v ON v.id=e.video_id
     WHERE e.owner_id=? AND e.kind='watch' AND e.created_at>=?
     GROUP BY v.id ORDER BY secs DESC LIMIT 6`).all(since, owner, since);

  // Advanced: revenue/day, geography, impressions/CTR, retention proxy.
  const revenueByDay = db.prepare(
    `SELECT ${dayExpr} d, SUM(seconds) s FROM analytics_events
     WHERE owner_id=? AND kind='revenue' AND created_at>=? GROUP BY d`).all(owner, since);
  const revenueCoins = db.prepare(
    `SELECT COALESCE(SUM(seconds),0) s FROM analytics_events WHERE owner_id=? AND kind='revenue' AND created_at>=?`).get(owner, since).s;
  const geography = db.prepare(
    `SELECT COALESCE(country,'Unknown') country, COUNT(*) c FROM analytics_events
     WHERE owner_id=? AND kind='view' AND created_at>=? GROUP BY country ORDER BY c DESC LIMIT 8`).all(owner, since);
  const impressions = db.prepare(
    `SELECT COUNT(*) c FROM analytics_events WHERE owner_id=? AND kind='impression' AND created_at>=?`).get(owner, since).c;
  // Retention proxy: average % of each video watched = total watch / (views * duration).
  const totalDurWeighted = db.prepare(
    `SELECT COALESCE(SUM(v.duration),0) s FROM analytics_events e JOIN videos v ON v.id=e.video_id
     WHERE e.owner_id=? AND e.kind='view' AND e.created_at>=?`).get(owner, since).s;
  const avgRetentionPct = totalDurWeighted ? Math.min(100, Math.round((totalWatch / totalDurWeighted) * 100)) : 0;

  // Build a gap-free day series for the chart.
  const watchMap = Object.fromEntries(watchByDay.map(r => [r.d, r.s]));
  const viewsMap = Object.fromEntries(viewsByDay.map(r => [r.d, r.c]));
  const revMap = Object.fromEntries(revenueByDay.map(r => [r.d, r.s]));
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400e3).toISOString().slice(0, 10);
    series.push({ day: d, watch: watchMap[d] || 0, views: viewsMap[d] || 0, revenue_coins: revMap[d] || 0 });
  }
  res.json({
    days, series, sources, topVideos, geography,
    totals: {
      views: totalViews, watch_seconds: totalWatch,
      avg_view_seconds: totalViews ? Math.round(totalWatch / totalViews) : 0,
      revenue_coins: revenueCoins, revenue_usd: (revenueCoins / eco.COINS_PER_USD).toFixed(2),
      impressions, ctr: impressions ? +((totalViews / impressions) * 100).toFixed(1) : 0,
      avg_retention_pct: avgRetentionPct,
    },
  });
});

// Log feed impressions (for CTR). Batched, capped, rate-limited.
app.post('/api/impressions', optionalAuth, limit('impr', 120, 60e3), (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.slice(0, 40).map(Number).filter(Boolean) : [];
  for (const id of ids) {
    const v = db.prepare('SELECT id, user_id FROM videos WHERE id=?').get(id);
    if (v) logEvent(v, 'impression', 0);
  }
  res.json({ ok: true });
});

/* ----------------------------- creator studio ----------------------------- */
app.get('/api/studio', auth, (req, res) => {
  const u = getUserById(req.user.id);
  const videos = db.prepare('SELECT * FROM videos WHERE user_id=? ORDER BY coins_earned DESC').all(u.id)
    .map(v => decorateVideo(v, u.id));
  const totalViews = videos.reduce((s, v) => s + v.views, 0);
  const totalEarned = videos.reduce((s, v) => s + v.coins_earned, 0);
  const subscribers = db.prepare('SELECT COUNT(*) c FROM subscriptions WHERE channel_id=?').get(u.id).c;
  const payouts = db.prepare('SELECT * FROM payouts WHERE user_id=? ORDER BY created_at DESC LIMIT 20').all(u.id);
  res.json({
    user: publicUser(u),
    videos, totalViews, totalEarned, subscribers, payouts,
    economy: {
      coins_per_usd: eco.COINS_PER_USD, min_payout_coins: eco.MIN_PAYOUT_COINS,
      commission_rate: eco.PLATFORM_COMMISSION_RATE, usd_to_inr: eco.USD_TO_INR,
      ad_revenue_coins: eco.AD_REVENUE_COINS, ad_split: eco.adSplit(),
    },
    payout_method: u.payout_method || 'stripe',
    stripe: { enabled: stripe.enabled, connected: !!u.stripe_account_id },
    upi: { enabled: upi.enabled, id: u.upi_id || null },
    paypal: { enabled: paypal.enabled, email: u.paypal_email || null },
    kyc: {
      status: u.kyc_status || 'unverified', name: u.kyc_name || null,
      country: u.kyc_country || null, id_last4: u.kyc_id_last4 || null,
    },
    monetization: monetizationStatus(u.id),
  });
});

// Turn on monetization once eligible (requires KYC).
app.post('/api/monetization/enable', auth, (req, res) => {
  const st = monetizationStatus(req.user.id);
  if (!st.eligible)
    return res.status(400).json({ error: `You need ${st.min_subs} subscribers and ${st.min_watch_hours} watch hours to monetize.` });
  if ((req.user.kyc_status || 'unverified') !== 'verified')
    return res.status(400).json({ error: 'Verify your identity (KYC) before enabling monetization.' });
  db.prepare('UPDATE users SET monetization_enabled=1 WHERE id=?').run(req.user.id);
  res.json({ ok: true, monetization: monetizationStatus(req.user.id) });
});

/* ----------------------------- platform (owner) ----------------------------- */
app.get('/api/platform/summary', auth, (req, res) => {
  if (!isOwner(req.user)) return res.status(403).json({ error: 'Owner access only.' });
  const owner = getOwnerUser();
  // Your ad income = commission on monetized videos + full revenue on non-monetized ones (in COINS).
  const adCommissionCoins = db.prepare("SELECT COALESCE(SUM(amount_cents),0) c FROM platform_ledger WHERE type IN ('ad_commission','ad_platform')").get().c;
  const adCount = db.prepare("SELECT COUNT(*) c FROM platform_ledger WHERE type IN ('ad_commission','ad_platform')").get().c;
  const monetizedCreators = db.prepare('SELECT COUNT(*) c FROM users WHERE monetization_enabled=1').get().c;
  const payoutCount = db.prepare("SELECT COUNT(*) c FROM payouts WHERE status IN ('paid','simulated')").get().c;
  const paidOut = db.prepare("SELECT COALESCE(SUM(net_cents),0) c FROM payouts WHERE status IN ('paid','simulated')").get().c;
  const users = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const videos = db.prepare('SELECT COUNT(*) c FROM videos').get().c;
  const openReports = db.prepare("SELECT COUNT(DISTINCT video_id) c FROM reports WHERE status='open'").get().c;
  const openAppeals = db.prepare("SELECT COUNT(*) c FROM appeals WHERE status='open'").get().c;
  const fraudFlags = db.prepare('SELECT COUNT(*) c FROM fraud_flags').get().c;
  const pendingKyc = db.prepare("SELECT COUNT(*) c FROM users WHERE kyc_status='pending'").get().c;
  const recent = db.prepare(
    `SELECT l.type, l.amount_cents AS coins, l.created_at, u.channel_name
     FROM platform_ledger l LEFT JOIN users u ON u.id = l.ref_user_id
     WHERE l.type IN ('ad_commission','ad_platform')
     ORDER BY l.created_at DESC LIMIT 25`
  ).all();
  res.json({
    ad_commission_coins: adCommissionCoins, ad_count: adCount, monetized_creators: monetizedCreators,
    owner_balance_coins: owner ? owner.coins : 0,
    payout_count: payoutCount, paid_out_cents: paidOut,
    users, videos, open_reports: openReports, open_appeals: openAppeals, fraud_flags: fraudFlags, pending_kyc: pendingKyc, recent,
    commission_rate: eco.PLATFORM_COMMISSION_RATE, coins_per_usd: eco.COINS_PER_USD,
  });
});

/* ----------------------------- moderation / reports ----------------------------- */
const REPORT_REASONS = ['Spam or misleading', 'Sexual content', 'Violence', 'Hate or harassment', 'Misinformation', 'Copyright', 'Other'];

app.post('/api/videos/:id/report', auth, limit('report', 30, 60e3), (req, res) => {
  const v = db.prepare('SELECT * FROM videos WHERE id=?').get(Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'Video not found.' });
  const reason = String(req.body.reason || '').trim();
  if (!REPORT_REASONS.includes(reason)) return res.status(400).json({ error: 'Pick a valid reason.' });
  // Idempotent: one open report per user per video.
  const dupe = db.prepare("SELECT 1 FROM reports WHERE video_id=? AND reporter_id=? AND status='open'").get(v.id, req.user.id);
  if (!dupe) {
    db.prepare('INSERT INTO reports (video_id, reporter_id, reason, details, created_at) VALUES (?,?,?,?,?)')
      .run(v.id, req.user.id, reason, String(req.body.details || '').slice(0, 500), Date.now());
  }
  // Automatic enforcement: enough distinct reports removes the video + strikes the creator.
  let autoRemoved = false;
  if (!v.removed) {
    const distinct = db.prepare("SELECT COUNT(DISTINCT reporter_id) c FROM reports WHERE video_id=? AND status='open'").get(v.id).c;
    if (distinct >= eco.AUTO_REMOVE_REPORTS) {
      db.prepare("UPDATE videos SET removed=1, removed_reason=? WHERE id=?").run(`Auto-removed after ${distinct} community reports`, v.id);
      db.prepare("UPDATE reports SET status='removed' WHERE video_id=? AND status='open'").run(v.id);
      issueStrike(v.user_id, v.id, `Auto-removed: ${reason}`);
      autoRemoved = true;
    }
  }
  res.json({ ok: true, auto_removed: autoRemoved });
});

app.get('/api/moderation/reports', auth, (req, res) => {
  if (!isOwner(req.user)) return res.status(403).json({ error: 'Owner access only.' });
  const videos = db.prepare(`
    SELECT v.id, v.title, v.filename, v.duration, v.removed, v.views,
           u.channel_name, u.avatar_color, u.id AS channel_id, u.strikes AS channel_strikes, u.terminated AS channel_terminated,
           COUNT(r.id) AS report_count, MAX(r.created_at) AS last_report
    FROM reports r JOIN videos v ON v.id = r.video_id JOIN users u ON u.id = v.user_id
    WHERE r.status = 'open'
    GROUP BY v.id ORDER BY report_count DESC, last_report DESC`).all();
  for (const v of videos) {
    v.url = store.urlFor(v.filename);
    v.reports = db.prepare("SELECT reason, details, created_at FROM reports WHERE video_id=? AND status='open' ORDER BY created_at DESC").all(v.id);
  }
  res.json({ videos, reasons: REPORT_REASONS });
});

app.post('/api/moderation/videos/:id/remove', auth, (req, res) => {
  if (!isOwner(req.user)) return res.status(403).json({ error: 'Owner access only.' });
  const v = db.prepare('SELECT * FROM videos WHERE id=?').get(Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'Video not found.' });
  const reason = String(req.body.reason || 'Violated community guidelines').slice(0, 200);
  const alreadyRemoved = v.removed;
  db.prepare('UPDATE videos SET removed=1, removed_reason=? WHERE id=?').run(reason, v.id);
  db.prepare("UPDATE reports SET status='removed' WHERE video_id=? AND status='open'").run(v.id);
  // Removing for a guideline violation gives the creator a strike (auto-terminates at the limit).
  let strikes = null, terminated = false;
  if (!alreadyRemoved) {
    strikes = issueStrike(v.user_id, v.id, reason);
    terminated = !!getUserById(v.user_id).terminated;
  }
  res.json({ ok: true, strikes, strike_limit: eco.STRIKE_LIMIT, terminated });
});

app.post('/api/moderation/videos/:id/keep', auth, (req, res) => {
  if (!isOwner(req.user)) return res.status(403).json({ error: 'Owner access only.' });
  const v = db.prepare('SELECT id FROM videos WHERE id=?').get(Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'Video not found.' });
  db.prepare('UPDATE videos SET removed=0, removed_reason=NULL WHERE id=?').run(v.id);
  db.prepare("UPDATE reports SET status='dismissed' WHERE video_id=? AND status='open'").run(v.id);
  res.json({ ok: true });
});

/* ----------------------------- strike appeals ----------------------------- */
// A creator appeals a removed video / strike.
app.post('/api/appeals', auth, limit('appeal', 5, 3600e3), (req, res) => {
  const videoId = Number(req.body.video_id) || null;
  const message = String(req.body.message || '').trim();
  if (message.length < 10) return res.status(400).json({ error: 'Tell us why this was a mistake (at least 10 characters).' });
  if (videoId) {
    const v = db.prepare('SELECT * FROM videos WHERE id=?').get(videoId);
    if (!v || v.user_id !== req.user.id) return res.status(404).json({ error: 'Video not found.' });
    if (!v.removed) return res.status(400).json({ error: 'That video is not currently removed.' });
    if (db.prepare("SELECT 1 FROM appeals WHERE user_id=? AND video_id=? AND status='open'").get(req.user.id, videoId))
      return res.status(409).json({ error: 'You already have an open appeal for this video.' });
  }
  const info = db.prepare('INSERT INTO appeals (user_id, video_id, message, created_at) VALUES (?,?,?,?)')
    .run(req.user.id, videoId, message.slice(0, 1000), Date.now());
  const owner = getOwnerUser();
  if (owner) notify(owner.id, 'appeal', `${req.user.channel_name} appealed a strike`, 'moderation');
  res.json({ appeal: db.prepare('SELECT * FROM appeals WHERE id=?').get(info.lastInsertRowid) });
});
app.get('/api/appeals', auth, (req, res) => {
  res.json({ appeals: db.prepare('SELECT * FROM appeals WHERE user_id=? ORDER BY created_at DESC').all(req.user.id) });
});
app.get('/api/moderation/appeals', auth, (req, res) => {
  if (!isOwner(req.user)) return res.status(403).json({ error: 'Owner access only.' });
  const rows = db.prepare(
    `SELECT a.*, u.channel_name, u.avatar_color, u.strikes, v.title AS video_title, v.removed_reason
     FROM appeals a JOIN users u ON u.id=a.user_id LEFT JOIN videos v ON v.id=a.video_id
     WHERE a.status='open' ORDER BY a.created_at DESC`).all();
  res.json({ appeals: rows });
});
app.post('/api/appeals/:id/decide', auth, (req, res) => {
  if (!isOwner(req.user)) return res.status(403).json({ error: 'Owner access only.' });
  const a = db.prepare('SELECT * FROM appeals WHERE id=?').get(Number(req.params.id));
  if (!a || a.status !== 'open') return res.status(404).json({ error: 'Appeal not found.' });
  const overturn = req.body.decision === 'overturned';
  db.prepare('UPDATE appeals SET status=?, decided_by=? WHERE id=?')
    .run(overturn ? 'overturned' : 'upheld', req.user.id, a.id);
  if (overturn) {
    // Restore the video and remove the strike; un-terminate if it drops below the limit.
    if (a.video_id) {
      db.prepare('UPDATE videos SET removed=0, removed_reason=NULL WHERE id=?').run(a.video_id);
      syncFts(a.video_id);
    }
    const u = getUserById(a.user_id);
    const newStrikes = Math.max(0, (u.strikes || 0) - 1);
    db.prepare('UPDATE users SET strikes=? WHERE id=?').run(newStrikes, u.id);
    if (u.terminated && newStrikes < eco.STRIKE_LIMIT) {
      db.prepare('UPDATE users SET terminated=0, terminated_at=NULL, terminated_reason=NULL WHERE id=?').run(u.id);
    }
    notify(a.user_id, 'appeal', '✅ Your appeal was approved — the strike was removed and your video restored.', 'mine');
  } else {
    notify(a.user_id, 'appeal', 'Your appeal was reviewed and the decision was upheld.', 'guidelines');
  }
  res.json({ ok: true });
});

// Owner: abuse / fraud flags raised by the heuristics.
app.get('/api/moderation/fraud', auth, (req, res) => {
  if (!isOwner(req.user)) return res.status(403).json({ error: 'Owner access only.' });
  const rows = db.prepare(
    `SELECT f.*, u.channel_name FROM fraud_flags f LEFT JOIN users u ON u.id=f.ref_user
     ORDER BY f.created_at DESC LIMIT 50`).all();
  res.json({ flags: rows });
});

// Pending KYC submissions awaiting owner review (only relevant when auto-approve is off).
app.get('/api/moderation/kyc', auth, (req, res) => {
  if (!isOwner(req.user)) return res.status(403).json({ error: 'Owner access only.' });
  const rows = db.prepare(
    `SELECT id, channel_name, email, kyc_name, kyc_country, kyc_id_last4, kyc_submitted_at
     FROM users WHERE kyc_status='pending' ORDER BY kyc_submitted_at ASC LIMIT 100`).all();
  res.json({ pending: rows, auto_approve: kyc.autoApprove });
});
// Approve or reject a pending KYC submission.
app.post('/api/moderation/kyc/:id/decide', auth, (req, res) => {
  if (!isOwner(req.user)) return res.status(403).json({ error: 'Owner access only.' });
  const target = getUserById(Number(req.params.id));
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if ((target.kyc_status || 'unverified') !== 'pending')
    return res.status(400).json({ error: 'This submission is not pending review.' });
  const approve = req.body.approve !== false;
  const status = approve ? 'verified' : 'rejected';
  db.prepare('UPDATE users SET kyc_status=? WHERE id=?').run(status, target.id);
  notify(target.id, 'kyc', approve
    ? 'Your identity was verified — you can now withdraw earnings.'
    : 'Your identity verification was rejected. Please resubmit with valid details.');
  res.json({ ok: true, kyc_status: status });
});

/* ----------------------------- Stripe payouts ----------------------------- */
app.post('/api/payouts/connect', auth, async (req, res) => {
  try {
    const result = await stripe.createOnboarding(req.user);
    db.prepare('UPDATE users SET stripe_account_id=? WHERE id=?').run(result.accountId, req.user.id);
    res.json(result); // { url } for real Stripe, { simulated:true } otherwise
  } catch (e) {
    res.status(500).json({ error: 'Stripe connect failed: ' + e.message });
  }
});

// Save a UPI ID (PhonePe / GPay / Paytm / any UPI app) and switch to UPI payouts.
app.put('/api/payouts/upi', auth, (req, res) => {
  const vpa = String(req.body.upi_id || '').trim();
  if (!upi.validVpa(vpa))
    return res.status(400).json({ error: 'Enter a valid UPI ID, e.g. name@ybl or 98765@paytm.' });
  db.prepare("UPDATE users SET upi_id=?, payout_method='upi' WHERE id=?").run(vpa, req.user.id);
  res.json({ ok: true, upi_id: vpa, payout_method: 'upi' });
});

// Save a PayPal email (for creators worldwide) and switch to PayPal payouts.
app.put('/api/payouts/paypal', auth, (req, res) => {
  const email = String(req.body.paypal_email || '').trim();
  if (!paypal.validEmail(email))
    return res.status(400).json({ error: 'Enter the email address on your PayPal account.' });
  db.prepare("UPDATE users SET paypal_email=?, payout_method='paypal' WHERE id=?").run(email, req.user.id);
  res.json({ ok: true, paypal_email: email, payout_method: 'paypal' });
});

// Choose which method to cash out with.
app.put('/api/payouts/method', auth, (req, res) => {
  const method = ['upi', 'paypal', 'stripe'].includes(req.body.method) ? req.body.method : 'stripe';
  db.prepare('UPDATE users SET payout_method=? WHERE id=?').run(method, req.user.id);
  res.json({ ok: true, payout_method: method });
});

// KYC identity verification — required before any withdrawal.
app.post('/api/kyc', auth, (req, res) => {
  const name = String(req.body.legal_name || '').trim();
  const country = String(req.body.country || '').trim().toUpperCase();
  const idnum = String(req.body.id_number || '').trim().toUpperCase();
  if (name.length < 3) return res.status(400).json({ error: 'Enter your full legal name.' });
  if (!country) return res.status(400).json({ error: 'Select your country.' });
  if (country === 'IN') {
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(idnum))
      return res.status(400).json({ error: 'Enter a valid PAN, e.g. ABCDE1234F.' });
  } else if (idnum.replace(/\s/g, '').length < 4) {
    return res.status(400).json({ error: 'Enter a valid government ID number.' });
  }
  // Status is gated by kyc.js: auto-approved in demo, but 'pending' owner review in
  // production (unless KYC_AUTO_APPROVE=true) so real payouts aren't self-verified.
  const status = kyc.initialStatus();
  db.prepare('UPDATE users SET kyc_status=?, kyc_name=?, kyc_id_last4=?, kyc_country=?, kyc_submitted_at=? WHERE id=?')
    .run(status, name, idnum.slice(-4), country, Date.now(), req.user.id);
  res.json({
    kyc_status: status, kyc_name: name,
    message: status === 'verified'
      ? 'Identity verified — you can withdraw earnings.'
      : 'Identity submitted — pending review. You can withdraw once it is approved.',
  });
});

app.post('/api/payouts/cashout', auth, async (req, res) => {
  const u = getUserById(req.user.id);
  if (u.coins < eco.MIN_PAYOUT_COINS)
    return res.status(400).json({ error: `You need at least ${eco.MIN_PAYOUT_COINS} coins to cash out.` });
  if ((u.kyc_status || 'unverified') !== 'verified')
    return res.status(403).json({ error: 'Complete identity verification (KYC) before withdrawing.' });

  const method = u.payout_method || 'stripe';
  const coins = u.coins;
  // No withdrawal fee — the platform's commission was already taken from ad revenue.
  const grossCents = eco.coinsToCents(coins), commissionCents = 0, netCents = grossCents;

  // Validate the destination BEFORE claiming the balance (so we never lock coins for a no-op).
  if (method === 'upi' && !u.upi_id) return res.status(400).json({ error: 'Add your UPI ID first.' });
  if (method === 'paypal' && !u.paypal_email) return res.status(400).json({ error: 'Add your PayPal email first.' });
  if (method === 'stripe' && !u.stripe_account_id) return res.status(400).json({ error: 'Connect a Stripe payout account first.' });

  // Atomically CLAIM the balance up front: this conditional zero-out only succeeds for
  // the first request, so two concurrent cash-outs can't both pass the balance check and
  // double-pay across the provider `await` below. Refund if the payout ultimately fails.
  const claim = db.prepare('UPDATE users SET coins = 0 WHERE id=? AND coins = ?').run(u.id, coins);
  if (claim.changes === 0) return res.status(409).json({ error: 'A withdrawal is already being processed. Refresh and try again.' });
  const refund = () => db.prepare('UPDATE users SET coins = coins + ? WHERE id=?').run(coins, u.id);

  // Finalize a successful payout: record it (coins were already claimed above).
  function finalize({ status, ref, currency, destAmount, destination, stripeId }) {
    db.prepare('UPDATE users SET cashed_out = cashed_out + ? WHERE id=?').run(coins, u.id);
    db.prepare(`INSERT INTO payouts
       (user_id, coins, usd_cents, commission_cents, net_cents, method, destination, currency, dest_amount, stripe_transfer_id, provider_ref, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(u.id, coins, grossCents, commissionCents, netCents, method, destination || null,
           currency, destAmount, stripeId || null, ref || null, status, Date.now());
    return {
      ok: true, coins, method,
      gross_usd: (grossCents / 100).toFixed(2),
      commission_usd: (commissionCents / 100).toFixed(2),
      net_usd: (netCents / 100).toFixed(2),
      commission_rate: eco.PLATFORM_COMMISSION_RATE,
      ref,
    };
  }

  if (method === 'upi') {
    const paise = eco.centsToPaise(netCents);
    let pout;
    try {
      pout = await upi.payout(u, u.upi_id, paise, 'Viomocoin payout');
    } catch (e) {
      refund(); // provider call failed — return the claimed coins to the creator
      db.prepare(`INSERT INTO payouts (user_id, coins, usd_cents, commission_cents, net_cents, method, destination, currency, dest_amount, status, created_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(u.id, coins, grossCents, commissionCents, netCents, 'upi', u.upi_id, 'inr', paise, 'failed', Date.now());
      return res.status(502).json({ error: 'UPI payout failed: ' + e.message });
    }
    const out = finalize({
      status: pout.simulated ? 'simulated' : 'paid', ref: pout.id,
      currency: 'inr', destAmount: paise, destination: u.upi_id,
    });
    return res.json({ ...out, simulated: !!pout.simulated, inr: (paise / 100).toFixed(2), upi_id: u.upi_id });
  }

  if (method === 'paypal') {
    // PayPal Payouts pay in USD to the creator's PayPal email (works worldwide).
    let pout;
    try {
      pout = await paypal.payout(u, u.paypal_email, netCents, 'Viomocoin creator payout');
    } catch (e) {
      refund(); // provider call failed — return the claimed coins to the creator
      db.prepare(`INSERT INTO payouts (user_id, coins, usd_cents, commission_cents, net_cents, method, destination, currency, dest_amount, status, created_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(u.id, coins, grossCents, commissionCents, netCents, 'paypal', u.paypal_email, 'usd', netCents, 'failed', Date.now());
      return res.status(502).json({ error: 'PayPal payout failed: ' + e.message });
    }
    // PayPal batches are async: the item settles via webhook, so record as 'processing'.
    const out = finalize({
      status: pout.simulated ? 'simulated' : 'processing', ref: pout.id,
      currency: 'usd', destAmount: netCents, destination: u.paypal_email,
    });
    return res.json({ ...out, simulated: !!pout.simulated, paypal_email: u.paypal_email });
  }

  // Stripe (default): send the net (after commission) to the creator's account.
  const ready = await stripe.payoutsReady(u.stripe_account_id);
  if (!ready) { refund(); return res.status(400).json({ error: 'Your Stripe payout account is not fully set up yet.' }); }
  let transfer;
  try {
    transfer = await stripe.transfer(u.stripe_account_id, netCents, { user_id: String(u.id), coins: String(coins) });
  } catch (e) {
    refund(); // provider call failed — return the claimed coins to the creator
    db.prepare(`INSERT INTO payouts (user_id, coins, usd_cents, commission_cents, net_cents, method, destination, currency, status, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(u.id, coins, grossCents, commissionCents, netCents, 'stripe', u.stripe_account_id, 'usd', 'failed', Date.now());
    return res.status(502).json({ error: 'Stripe transfer failed: ' + e.message });
  }
  const out = finalize({
    status: transfer.simulated ? 'simulated' : 'paid', ref: transfer.id,
    currency: 'usd', destAmount: netCents, destination: u.stripe_account_id, stripeId: transfer.id,
  });
  res.json({ ...out, simulated: !!transfer.simulated });
});

/* ----------------------------- playlists ----------------------------- */
function playlistCard(p) {
  const count = db.prepare('SELECT COUNT(*) c FROM playlist_videos WHERE playlist_id=?').get(p.id).c;
  const first = db.prepare(
    `SELECT v.filename FROM playlist_videos pv JOIN videos v ON v.id=pv.video_id
     WHERE pv.playlist_id=? AND v.removed=0 ORDER BY pv.added_at LIMIT 1`).get(p.id);
  return { id: p.id, title: p.title, count, thumb: first ? store.urlFor(first.filename) : null };
}
app.get('/api/playlists', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM playlists WHERE user_id=? ORDER BY created_at DESC').all(req.user.id);
  res.json({ playlists: rows.map(playlistCard) });
});
app.post('/api/playlists', auth, (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Playlist name is required.' });
  const info = db.prepare('INSERT INTO playlists (user_id, title, created_at) VALUES (?,?,?)').run(req.user.id, title.slice(0, 100), Date.now());
  res.json({ playlist: playlistCard(getById('playlists', info.lastInsertRowid)) });
});
app.get('/api/playlists/:id', auth, (req, res) => {
  const p = getById('playlists', Number(req.params.id));
  if (!p || p.user_id !== req.user.id) return res.status(404).json({ error: 'Playlist not found.' });
  const videos = db.prepare(
    `SELECT v.* FROM playlist_videos pv JOIN videos v ON v.id=pv.video_id
     WHERE pv.playlist_id=? AND v.removed=0 ORDER BY pv.added_at DESC`).all(p.id).map(v => decorateVideo(v, req.user.id));
  res.json({ playlist: { id: p.id, title: p.title }, videos });
});
app.post('/api/playlists/:id/videos', auth, (req, res) => {
  const p = getById('playlists', Number(req.params.id));
  if (!p || p.user_id !== req.user.id) return res.status(404).json({ error: 'Playlist not found.' });
  const videoId = Number(req.body.video_id);
  if (!getById('videos', videoId)) return res.status(404).json({ error: 'Video not found.' });
  db.prepare('INSERT OR IGNORE INTO playlist_videos (playlist_id, video_id, added_at) VALUES (?,?,?)').run(p.id, videoId, Date.now());
  res.json({ ok: true });
});
app.delete('/api/playlists/:id/videos/:videoId', auth, (req, res) => {
  const p = getById('playlists', Number(req.params.id));
  if (!p || p.user_id !== req.user.id) return res.status(404).json({ error: 'Playlist not found.' });
  db.prepare('DELETE FROM playlist_videos WHERE playlist_id=? AND video_id=?').run(p.id, Number(req.params.videoId));
  res.json({ ok: true });
});
app.delete('/api/playlists/:id', auth, (req, res) => {
  const p = getById('playlists', Number(req.params.id));
  if (!p || p.user_id !== req.user.id) return res.status(404).json({ error: 'Playlist not found.' });
  db.prepare('DELETE FROM playlists WHERE id=?').run(p.id);
  res.json({ ok: true });
});
function getById(table, id) { return db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id); }

/* ----------------------------- live streaming ----------------------------- */
// In-memory viewer presence (viewers ping a heartbeat; stale entries expire).
const liveViewers = new Map(); // streamId -> Map(viewerKey -> lastTs)
const VIEWER_TTL = 15000;
function currentViewers(streamId) {
  const m = liveViewers.get(streamId);
  if (!m) return 0;
  const now = Date.now();
  for (const [k, ts] of m) if (now - ts > VIEWER_TTL) m.delete(k);
  return m.size;
}
function liveInfo(s) {
  const owner = getUserById(s.user_id);
  return {
    id: s.id, title: s.title, category: s.category, status: s.status,
    started_at: s.started_at, ended_at: s.ended_at,
    channel_id: s.user_id, channel_name: owner ? owner.channel_name : 'Unknown',
    avatar_color: owner ? owner.avatar_color : '#555',
    viewers: currentViewers(s.id), peak_viewers: s.peak_viewers,
  };
}
app.get('/api/live', optionalAuth, (_req, res) => {
  const rows = db.prepare("SELECT * FROM live_streams WHERE status='live' ORDER BY started_at DESC").all();
  res.json({ streams: rows.map(liveInfo) });
});
app.post('/api/live', auth, (req, res) => {
  if (!req.user.email_verified) return res.status(403).json({ error: 'Verify your email before going live.' });
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Give your stream a title.' });
  // One active stream per creator.
  db.prepare("UPDATE live_streams SET status='ended', ended_at=? WHERE user_id=? AND status='live'").run(Date.now(), req.user.id);
  const info = db.prepare('INSERT INTO live_streams (user_id, title, category, started_at) VALUES (?,?,?,?)')
    .run(req.user.id, title.slice(0, 120), String(req.body.category || 'Other'), Date.now());
  res.json({ stream: liveInfo(getById('live_streams', info.lastInsertRowid)) });
});
app.get('/api/live/:id', optionalAuth, (req, res) => {
  const s = getById('live_streams', Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Stream not found.' });
  const info = liveInfo(s);
  info.is_broadcaster = req.user && req.user.id === s.user_id;
  res.json({ stream: info });
});
app.post('/api/live/:id/end', auth, (req, res) => {
  const s = getById('live_streams', Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Stream not found.' });
  if (s.user_id !== req.user.id) return res.status(403).json({ error: 'Not your stream.' });
  db.prepare("UPDATE live_streams SET status='ended', ended_at=? WHERE id=?").run(Date.now(), s.id);
  res.json({ ok: true });
});
app.post('/api/live/:id/heartbeat', optionalAuth, (req, res) => {
  const s = getById('live_streams', Number(req.params.id));
  if (!s || s.status !== 'live') return res.json({ viewers: 0, status: s ? s.status : 'ended' });
  const key = req.user ? 'u:' + req.user.id : 'anon:' + req.ip;
  if (!liveViewers.has(s.id)) liveViewers.set(s.id, new Map());
  liveViewers.get(s.id).set(key, Date.now());
  const n = currentViewers(s.id);
  if (n > s.peak_viewers) db.prepare('UPDATE live_streams SET peak_viewers=? WHERE id=?').run(n, s.id);
  res.json({ viewers: n, status: 'live' });
});
app.get('/api/live/:id/chat', (req, res) => {
  const streamId = Number(req.params.id);
  const s = getById('live_streams', streamId);
  const channelId = s ? s.user_id : null;
  const emojis = channelId ? emojiMapFor(channelId) : {};
  const since = Number(req.query.since) || 0;
  const rows = db.prepare(
    `SELECT c.id, c.body, c.amount, c.created_at, c.user_id, u.channel_name, u.avatar_color
     FROM live_chat c JOIN users u ON u.id=c.user_id
     WHERE c.stream_id=? AND c.id > ? ORDER BY c.id ASC LIMIT 100`).all(streamId, since);
  for (const m of rows) {
    m.member_badge = channelId ? memberBadge(m.user_id, channelId) : null;
    m.is_creator = m.user_id === channelId;
    m.body = renderEmoji(m.body, emojis);
  }
  res.json({ messages: rows });
});
app.post('/api/live/:id/chat', auth, (req, res) => {
  const s = getById('live_streams', Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Stream not found.' });
  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Message is empty.' });
  const info = db.prepare('INSERT INTO live_chat (stream_id, user_id, body, created_at) VALUES (?,?,?,?)')
    .run(s.id, req.user.id, body.slice(0, 300), Date.now());
  res.json({ message: { id: info.lastInsertRowid, body: body.slice(0, 300), amount: 0, created_at: Date.now(), channel_name: req.user.channel_name, avatar_color: req.user.avatar_color } });
});

// Super-chat: spend coins to send a highlighted, pinned live-chat message to the streamer.
app.post('/api/live/:id/superchat', auth, (req, res) => {
  const s = getById('live_streams', Number(req.params.id));
  if (!s || s.status !== 'live') return res.status(404).json({ error: 'Stream is not live.' });
  const amount = Math.floor(Number(req.body.amount) || 0);
  if (amount <= 0) return res.status(400).json({ error: 'Pick a super-chat amount.' });
  if (s.user_id === req.user.id) return res.status(400).json({ error: "You can't super-chat your own stream." });
  const me = getUserById(req.user.id);
  if (me.coins < amount) return res.status(400).json({ error: `Not enough coins. You have ${me.coins}.` });
  const body = String(req.body.body || '').trim().slice(0, 200);
  // Move coins from viewer to streamer.
  db.prepare('UPDATE users SET coins = coins - ? WHERE id=?').run(amount, req.user.id);
  db.prepare('UPDATE users SET coins = coins + ? WHERE id=?').run(amount, s.user_id);
  const info = db.prepare('INSERT INTO live_chat (stream_id, user_id, body, amount, created_at) VALUES (?,?,?,?,?)')
    .run(s.id, req.user.id, body, amount, Date.now());
  notify(s.user_id, 'superchat', `💰 ${req.user.channel_name} sent a ${amount}-coin Super Chat!`, 'liveroom', s.id);
  res.json({
    message: { id: info.lastInsertRowid, body, amount, created_at: Date.now(), channel_name: req.user.channel_name, avatar_color: req.user.avatar_color },
    balance: getUserById(req.user.id).coins,
  });
});

/* ----------------------------- tips, wallet, notifications ----------------------------- */
// Tip a creator coins on a regular video.
app.post('/api/videos/:id/tip', auth, (req, res) => {
  const v = db.prepare('SELECT * FROM videos WHERE id=?').get(Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'Video not found.' });
  if (v.user_id === req.user.id) return res.status(400).json({ error: "You can't tip your own video." });
  const amount = Math.floor(Number(req.body.amount) || 0);
  if (amount <= 0) return res.status(400).json({ error: 'Pick a tip amount.' });
  const me = getUserById(req.user.id);
  if (me.coins < amount) return res.status(400).json({ error: `Not enough coins. You have ${me.coins}.` });
  db.prepare('UPDATE users SET coins = coins - ? WHERE id=?').run(amount, req.user.id);
  creditOwner(v, amount); // adds to creator coins + video earnings
  notify(v.user_id, 'tip', `🪙 ${req.user.channel_name} tipped you ${amount} coins on “${v.title}”`, 'watch', v.id);
  res.json({ ok: true, balance: getUserById(req.user.id).coins });
});

// Add coins to your wallet (simulated purchase; real impl would use Stripe Checkout).
app.post('/api/wallet/topup', auth, (req, res) => {
  const amount = Math.floor(Number(req.body.amount) || 0);
  if (amount <= 0 || amount > 100000) return res.status(400).json({ error: 'Choose a valid coin pack.' });
  db.prepare('UPDATE users SET coins = coins + ? WHERE id=?').run(amount, req.user.id);
  res.json({ ok: true, balance: getUserById(req.user.id).coins, simulated: true });
});

// Notifications
app.get('/api/notifications', auth, (req, res) => {
  const items = db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 40').all(req.user.id);
  const unread = db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read=0').get(req.user.id).c;
  res.json({ notifications: items, unread });
});
app.get('/api/notifications/unread', auth, (req, res) => {
  res.json({ unread: db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read=0').get(req.user.id).c });
});
app.post('/api/notifications/read', auth, (req, res) => {
  db.prepare('UPDATE notifications SET read=1 WHERE user_id=? AND read=0').run(req.user.id);
  res.json({ ok: true });
});

/* ----------------------------- Viomo AI help assistant ----------------------------- */
// Anyone can ask (works on the landing page too), but rate-limited to control cost.
app.post('/api/assistant', optionalAuth, limit('assistant', 20, 60e3), async (req, res) => {
  const message = String(req.body.message || '').trim().slice(0, 1000);
  if (!message) return res.status(400).json({ error: 'Ask a question first.' });
  // Only keep clean prior turns so we can't be fed arbitrary role/content.
  const history = (Array.isArray(req.body.history) ? req.body.history : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-8)
    .map(m => ({ role: m.role, content: String(m.content).slice(0, 2000) }));
  try {
    res.json(await assistant.answer(message, history));
  } catch (e) {
    res.status(500).json({ error: 'Assistant unavailable: ' + e.message });
  }
});

/* ----------------------------- webhooks ----------------------------- */
// Update a payout's status from a provider event. On failure/reversal after a
// successful payout, refund the creator's coins and reverse the commission.
function settlePayout(providerRef, status) {
  const p = db.prepare('SELECT * FROM payouts WHERE provider_ref=? OR stripe_transfer_id=?').get(providerRef, providerRef);
  if (!p || p.status === status) return !!p;
  const wasCredited = ['paid', 'processing', 'simulated'].includes(p.status);
  db.prepare('UPDATE payouts SET status=? WHERE id=?').run(status, p.id);
  if ((status === 'failed' || status === 'reversed') && wasCredited) {
    db.prepare('UPDATE users SET coins = coins + ?, cashed_out = cashed_out - ? WHERE id=?')
      .run(p.coins, p.coins, p.user_id);
    creditPlatform('commission', -(p.commission_cents || 0), p.user_id); // reverse the fee
  }
  return true;
}

// Stripe: transfer lifecycle events for creator payouts.
app.post('/api/webhooks/stripe', (req, res) => {
  if (!stripe.enabled || !stripe.webhookSecret) return res.json({ skipped: true });
  let event;
  try { event = stripe.constructEvent(req.rawBody, req.headers['stripe-signature']); }
  catch (e) { return res.status(400).send('Webhook signature verification failed'); }
  const obj = event.data.object;
  if (event.type === 'transfer.paid') settlePayout(obj.id, 'paid');
  else if (event.type === 'transfer.reversed') settlePayout(obj.id, 'reversed');
  else if (event.type === 'transfer.failed') settlePayout(obj.id, 'failed');
  res.json({ received: true });
});

// Razorpay: UPI payout lifecycle events.
app.post('/api/webhooks/razorpay', (req, res) => {
  if (!upi.webhookSecret) return res.json({ skipped: true });
  if (!upi.verifyWebhook(req.rawBody, req.headers['x-razorpay-signature']))
    return res.status(400).send('Invalid signature');
  const event = req.body.event;
  const payout = req.body.payload?.payout?.entity;
  if (payout) {
    if (event === 'payout.processed') settlePayout(payout.id, 'paid');
    else if (event === 'payout.reversed') settlePayout(payout.id, 'reversed');
    else if (event === 'payout.failed') settlePayout(payout.id, 'failed');
  }
  res.json({ received: true });
});

// PayPal: payout-item lifecycle events for worldwide creator payouts.
app.post('/api/webhooks/paypal', async (req, res) => {
  if (!paypal.enabled || !paypal.webhookId) return res.json({ skipped: true });
  const ok = await paypal.verifyWebhook(req.headers, req.rawBody);
  if (!ok) return res.status(400).send('Invalid signature');
  const type = req.body.event_type;
  // The batch id (our provider_ref) is on the resource for item + batch events.
  const ref = req.body.resource?.payout_batch_id
    || req.body.resource?.batch_header?.payout_batch_id;
  if (ref) {
    if (type === 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED') settlePayout(ref, 'paid');
    else if (type === 'PAYMENT.PAYOUTS-ITEM.FAILED' || type === 'PAYMENT.PAYOUTS-ITEM.BLOCKED') settlePayout(ref, 'failed');
    else if (type === 'PAYMENT.PAYOUTS-ITEM.RETURNED' || type === 'PAYMENT.PAYOUTS-ITEM.REFUNDED') settlePayout(ref, 'reversed');
  }
  res.json({ received: true });
});

/* ----------------------------- static + boot ----------------------------- */
app.use('/uploads', express.static(UPLOAD_DIR, { acceptRanges: true, maxAge: '1h' }));
app.use(express.static(path.join(__dirname, 'public')));

// Multer / body errors -> clean JSON
app.use((err, _req, res, _next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `Video exceeds the ${MAX_UPLOAD_MB} MB limit.` });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

app.listen(PORT, () => {
  console.log(`Viomocoin running on http://localhost:${PORT}${IS_PROD ? ' (production)' : ''}`);
  console.log(`Stripe payouts: ${stripe.enabled ? 'LIVE' : 'SIMULATED'}${stripe.webhookSecret ? ' + webhook' : ''}`);
  console.log(`UPI payouts:    ${upi.enabled ? 'LIVE (Razorpay)' : 'SIMULATED'}${upi.webhookSecret ? ' + webhook' : ''}`);
  console.log(`PayPal payouts: ${paypal.enabled ? 'LIVE (' + paypal.env + ')' : 'SIMULATED'}${paypal.webhookId ? ' + webhook' : ''}`);
  console.log(`Storage: ${store.s3Enabled ? 'S3' : 'local disk'}${store.cdnEnabled ? ' + CDN' : ''} · Transcode: ${transcode.available ? 'ffmpeg' + (transcode.hls ? '+HLS' : '') : 'passthrough'} · Live: ${livemedia.provider || 'browser-preview'} · Google OAuth: ${oauth.enabled ? 'ON' : 'off'}`);
  console.log(`Email: ${mailer.simulated ? 'SIMULATED' : 'SMTP'} · KYC: ${kyc.autoApprove ? 'auto-approve' : 'manual owner review'} · Viomo AI: ${assistant.enabled ? 'LIVE (' + assistant.model + ')' : 'FAQ (no ANTHROPIC_API_KEY)'}`);
  // Warn loudly if production is running on ephemeral local disk — data is lost on redeploy.
  if (IS_PROD && !store.s3Enabled && !process.env.VIOMOCOIN_UPLOAD_DIR) {
    console.warn('⚠️  WARNING: uploads are on local disk with no persistent volume. On ephemeral hosts they will be LOST on every redeploy. Set S3 credentials or point VIOMOCOIN_UPLOAD_DIR (and VIOMOCOIN_DB) at a mounted volume.');
  }
});
