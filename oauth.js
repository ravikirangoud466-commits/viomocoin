'use strict';
/*
 * Google OAuth (Sign in with Google). Enabled when GOOGLE_CLIENT_ID and
 * GOOGLE_CLIENT_SECRET are set. Uses the standard authorization-code flow via
 * Google's public endpoints — no SDK required (plain fetch).
 *
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, BASE_URL
 */
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const BASE_URL = process.env.BASE_URL || 'http://localhost:5178';
const ENABLED = !!(CLIENT_ID && CLIENT_SECRET);
const REDIRECT = `${BASE_URL}/api/auth/google/callback`;

module.exports = {
  enabled: ENABLED,

  authUrl(state) {
    const p = new URLSearchParams({
      client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: 'code',
      scope: 'openid email profile', access_type: 'online', state, prompt: 'select_account',
    });
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
  },

  // Exchange the code and return { email, name } or throw.
  async exchange(code) {
    const tokRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT, grant_type: 'authorization_code' }),
    });
    const tok = await tokRes.json();
    if (!tok.access_token) throw new Error(tok.error_description || 'Google sign-in failed');
    const infoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + tok.access_token } });
    const info = await infoRes.json();
    if (!info.email) throw new Error('Google did not return an email.');
    return { email: String(info.email).toLowerCase(), name: info.name || info.email.split('@')[0], verified: !!info.verified_email };
  },
};
