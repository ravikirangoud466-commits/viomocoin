'use strict';
/*
 * SQLite database layer using Node's built-in node:sqlite (no native build needed).
 * Creates the schema on first run and exposes the DatabaseSync handle.
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = process.env.VIOMOCOIN_DB || path.join(__dirname, 'viomocoin.db');
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  channel_name   TEXT NOT NULL,
  avatar_color   TEXT NOT NULL DEFAULT '#ff2d55',
  coins          INTEGER NOT NULL DEFAULT 0,
  cashed_out     INTEGER NOT NULL DEFAULT 0,        -- lifetime coins withdrawn
  stripe_account_id TEXT,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS videos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT DEFAULT '',
  category     TEXT DEFAULT 'Other',
  filename     TEXT NOT NULL,
  duration     REAL NOT NULL DEFAULT 0,
  views        INTEGER NOT NULL DEFAULT 0,
  likes        INTEGER NOT NULL DEFAULT 0,
  coins_earned INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id   INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS video_likes (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, video_id)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  subscriber_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (subscriber_id, channel_id)
);

CREATE TABLE IF NOT EXISTS payouts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  coins             INTEGER NOT NULL,
  usd_cents         INTEGER NOT NULL,                  -- gross (before commission)
  commission_cents  INTEGER NOT NULL DEFAULT 0,        -- platform's cut
  net_cents         INTEGER NOT NULL DEFAULT 0,        -- what the creator received (USD cents)
  method            TEXT NOT NULL DEFAULT 'stripe',    -- stripe | upi
  destination       TEXT,                              -- UPI id or stripe acct
  currency          TEXT NOT NULL DEFAULT 'usd',       -- usd | inr
  dest_amount       INTEGER,                           -- amount actually sent in dest currency's minor unit
  stripe_transfer_id TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',   -- pending | paid | simulated | failed
  created_at        INTEGER NOT NULL
);

-- The platform (app owner) earnings: commission on payouts + ad revenue.
CREATE TABLE IF NOT EXISTS platform_ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,                -- commission | ad_revenue
  amount_cents INTEGER NOT NULL,            -- USD cents
  ref_user_id INTEGER,
  ref_video_id INTEGER,
  created_at  INTEGER NOT NULL
);

-- throttle ad impressions the same way as paid views
CREATE TABLE IF NOT EXISTS ad_events (
  video_id INTEGER NOT NULL,
  viewer   TEXT NOT NULL,
  last_ts  INTEGER NOT NULL,
  PRIMARY KEY (video_id, viewer)
);

-- content moderation: user reports on videos
CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id    INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason      TEXT NOT NULL,
  details     TEXT DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open',   -- open | removed | dismissed
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_video ON reports(video_id);

-- comment likes
CREATE TABLE IF NOT EXISTS comment_likes (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, comment_id)
);

-- channel community posts (optionally with a poll)
CREATE TABLE IF NOT EXISTS community_posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  likes      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS post_likes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id INTEGER NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, post_id)
);
CREATE TABLE IF NOT EXISTS poll_options (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  text    TEXT NOT NULL,
  votes   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS poll_votes (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id   INTEGER NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, post_id)
);

-- channel memberships (paid tiers, priced in coins, 30-day terms)
CREATE TABLE IF NOT EXISTS membership_tiers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  price_coins INTEGER NOT NULL,
  perks       TEXT DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier_id    INTEGER NOT NULL REFERENCES membership_tiers(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id, channel_id);

-- custom channel emoji (usable by that channel's members)
CREATE TABLE IF NOT EXISTS channel_emoji (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code       TEXT NOT NULL,   -- e.g. :wave:
  symbol     TEXT NOT NULL,   -- the emoji/character shown
  created_at INTEGER NOT NULL
);

-- channel merch shelf
CREATE TABLE IF NOT EXISTS merch_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  price      TEXT NOT NULL,
  url        TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- dislikes (mutually exclusive with a like, as on YouTube)
CREATE TABLE IF NOT EXISTS video_dislikes (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, video_id)
);

-- watch history (one row per user+video, updated on each view)
CREATE TABLE IF NOT EXISTS watch_history (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id   INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  watched_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, video_id)
);

-- Watch Later queue
CREATE TABLE IF NOT EXISTS watch_later (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, video_id)
);

-- full-text search index (rowid == videos.id), kept in sync by syncFts()
CREATE VIRTUAL TABLE IF NOT EXISTS videos_fts USING fts5(title, description, tags, channel);

-- playlists
CREATE TABLE IF NOT EXISTS playlists (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS playlist_videos (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  video_id    INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, video_id)
);

-- live streaming
CREATE TABLE IF NOT EXISTS live_streams (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  category     TEXT DEFAULT 'Other',
  status       TEXT NOT NULL DEFAULT 'live',   -- live | ended
  peak_viewers INTEGER NOT NULL DEFAULT 0,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER
);
CREATE TABLE IF NOT EXISTS live_chat (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id  INTEGER NOT NULL REFERENCES live_streams(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- notifications
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,       -- subscribe | comment | superchat | tip | new_video | strike | terminated
  body       TEXT NOT NULL,
  page       TEXT,                -- SPA route to open on click
  arg        TEXT,
  read       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read);

-- community-guidelines strikes
CREATE TABLE IF NOT EXISTS strikes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id   INTEGER,
  reason     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- strike appeals
CREATE TABLE IF NOT EXISTS appeals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  strike_id  INTEGER,
  video_id   INTEGER,
  message    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',   -- open | upheld | overturned
  decided_by INTEGER,
  created_at INTEGER NOT NULL
);

-- abuse signals + rate limiting (generic action counter with a sliding window)
CREATE TABLE IF NOT EXISTS rate_events (
  actor  TEXT NOT NULL,     -- "u:<id>" or "ip:<addr>"
  action TEXT NOT NULL,
  ts     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate ON rate_events(actor, action, ts);

-- fraud flags raised by the abuse heuristics (for the owner's review)
CREATE TABLE IF NOT EXISTS fraud_flags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,     -- view_fraud | spam | dupe_upload
  ref_user   INTEGER,
  ref_video  INTEGER,
  detail     TEXT,
  created_at INTEGER NOT NULL
);

-- content fingerprints for duplicate / copyright matching (lightweight Content ID)
CREATE TABLE IF NOT EXISTS content_fingerprints (
  fingerprint TEXT NOT NULL,
  video_id    INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (fingerprint, video_id)
);
CREATE INDEX IF NOT EXISTS idx_fp ON content_fingerprints(fingerprint);

-- creator analytics: one row per view / watch-tick, for graphs + traffic sources
CREATE TABLE IF NOT EXISTS analytics_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id   INTEGER NOT NULL,
  video_id   INTEGER NOT NULL,
  kind       TEXT NOT NULL,     -- view | watch
  seconds    INTEGER NOT NULL DEFAULT 0,
  source     TEXT,              -- Home | Search | Trending | Suggested | Channel | Subscriptions | Share | Direct
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analytics_owner ON analytics_events(owner_id, created_at);

-- one earning-view per viewer per video per window (anti-abuse throttle)
CREATE TABLE IF NOT EXISTS view_events (
  video_id  INTEGER NOT NULL,
  viewer    TEXT NOT NULL,   -- user id or anon:ip
  last_ts   INTEGER NOT NULL,
  PRIMARY KEY (video_id, viewer)
);

CREATE INDEX IF NOT EXISTS idx_videos_user ON videos(user_id);
CREATE INDEX IF NOT EXISTS idx_comments_video ON comments(video_id);
CREATE INDEX IF NOT EXISTS idx_subs_channel ON subscriptions(channel_id);
`);

/* Lightweight migrations so older databases pick up new columns. */
function addColumn(table, col, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch { /* already exists */ }
}
addColumn('users', 'upi_id', 'TEXT');
addColumn('users', 'paypal_email', 'TEXT');                            // PayPal Payouts recipient email
addColumn('users', 'payout_method', "TEXT NOT NULL DEFAULT 'stripe'"); // stripe | upi | paypal
addColumn('users', 'kyc_status', "TEXT NOT NULL DEFAULT 'unverified'"); // unverified | pending | verified
addColumn('users', 'kyc_name', 'TEXT');
addColumn('users', 'kyc_id_last4', 'TEXT');
addColumn('users', 'kyc_country', 'TEXT');
addColumn('users', 'kyc_submitted_at', 'INTEGER');
addColumn('users', 'email_verified', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'verify_token', 'TEXT');
addColumn('users', 'verify_expires', 'INTEGER');
addColumn('users', 'reset_token', 'TEXT');
addColumn('users', 'reset_expires', 'INTEGER');
addColumn('users', 'twofa_enabled', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'twofa_code', 'TEXT');
addColumn('users', 'twofa_expires', 'INTEGER');
addColumn('live_chat', 'amount', 'INTEGER NOT NULL DEFAULT 0'); // super-chat coin amount
addColumn('users', 'monetization_enabled', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'monetization_notified', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'strikes', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'terminated', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'terminated_at', 'INTEGER');
addColumn('users', 'terminated_reason', 'TEXT');
addColumn('videos', 'removed', 'INTEGER NOT NULL DEFAULT 0');
addColumn('videos', 'removed_reason', 'TEXT');
addColumn('videos', 'thumbnail', 'TEXT');                             // custom thumbnail filename
addColumn('videos', 'visibility', "TEXT NOT NULL DEFAULT 'public'");  // public | unlisted | private
addColumn('videos', 'publish_at', 'INTEGER');                         // scheduled publish time (ms)
addColumn('videos', 'tags', "TEXT NOT NULL DEFAULT ''");              // space-separated hashtags
addColumn('videos', 'dislikes', 'INTEGER NOT NULL DEFAULT 0');
addColumn('comments', 'parent_id', 'INTEGER');                    // null = top-level; else a reply
addColumn('comments', 'likes', 'INTEGER NOT NULL DEFAULT 0');
addColumn('comments', 'pinned', 'INTEGER NOT NULL DEFAULT 0');    // one pinned comment per video
addColumn('comments', 'hearted', 'INTEGER NOT NULL DEFAULT 0');   // creator ❤ on a comment
addColumn('videos', 'age_restricted', 'INTEGER NOT NULL DEFAULT 0'); // 18+ only
addColumn('videos', 'fingerprint', 'TEXT');                      // content fingerprint (dupe detection)
addColumn('users', 'birth_year', 'INTEGER');                     // for age-gate
addColumn('users', 'restricted_mode', 'INTEGER NOT NULL DEFAULT 0'); // hide mature content
addColumn('videos', 'captions', 'TEXT');   // WebVTT subtitles (inline)
addColumn('videos', 'chapters', 'TEXT');   // JSON: [{t:seconds,label}]
addColumn('videos', 'is_short', 'INTEGER NOT NULL DEFAULT 0'); // vertical Shorts
addColumn('analytics_events', 'country', 'TEXT');            // coarse geography for reports
addColumn('users', 'locale', "TEXT NOT NULL DEFAULT 'en'");  // preferred UI language
addColumn('users', 'tax_form', 'TEXT');                      // W-9 | W-8BEN
addColumn('users', 'tax_name', 'TEXT');
addColumn('users', 'tax_country', 'TEXT');
addColumn('users', 'tax_id_last4', 'TEXT');
addColumn('users', 'google_id', 'TEXT');                     // linked Google account
addColumn('videos', 'members_only', 'INTEGER NOT NULL DEFAULT 0');          // gated to channel members
addColumn('community_posts', 'members_only', 'INTEGER NOT NULL DEFAULT 0'); // members-only post
addColumn('users', 'banner', 'TEXT');                    // channel banner image filename
addColumn('users', 'avatar_img', 'TEXT');                // uploaded avatar image filename
addColumn('users', 'about', "TEXT NOT NULL DEFAULT ''"); // channel description
addColumn('users', 'links', "TEXT NOT NULL DEFAULT '[]'"); // JSON [{label,url}]
addColumn('users', 'trailer_id', 'INTEGER');             // featured video for non-subscribers
addColumn('videos', 'cards', "TEXT NOT NULL DEFAULT '[]'");     // JSON [{t:seconds, video_id, label}]
addColumn('videos', 'end_screen', 'INTEGER NOT NULL DEFAULT 1'); // show end screen (suggested + subscribe)
addColumn('videos', 'premiere_at', 'INTEGER');          // scheduled premiere time (ms) — live countdown
addColumn('payouts', 'commission_cents', 'INTEGER NOT NULL DEFAULT 0');
addColumn('payouts', 'net_cents', 'INTEGER NOT NULL DEFAULT 0');
addColumn('payouts', 'method', "TEXT NOT NULL DEFAULT 'stripe'");
addColumn('payouts', 'destination', 'TEXT');
addColumn('payouts', 'currency', "TEXT NOT NULL DEFAULT 'usd'");
addColumn('payouts', 'dest_amount', 'INTEGER');
addColumn('payouts', 'provider_ref', 'TEXT'); // stripe transfer id or razorpay payout id

module.exports = db;
