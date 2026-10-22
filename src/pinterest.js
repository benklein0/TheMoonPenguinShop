// src/pinterest.js
// Posts product pins to Pinterest via the Pinterest API v5.
//
// Pinterest access tokens expire every ~30 days. Rather than needing a new
// one pasted into Railway by hand every month, this keeps a refresh token
// on disk (in the same ./data volume the poster already uses for
// listings.json/reel_type.json) and silently exchanges it for a new access
// token whenever the current one is missing, expired, or about to expire.
//
// Required env vars (set in Railway):
//   PINTEREST_CLIENT_ID      - the app's App ID
//   PINTEREST_CLIENT_SECRET  - the app's App secret key
//   PINTEREST_BOARD_ID       - the board to pin to
//   PINTEREST_ACCESS_TOKEN   - seed value, only used the very first run
//   PINTEREST_REFRESH_TOKEN  - seed value, only used the very first run
// After the first successful run, the live tokens are read from/written to
// data/pinterest_token.json instead of these env vars, so a manually
// refreshed env var afterwards would have no effect until that file is
// cleared.

const axios = require('axios');
const { siteUrl } = require('./links');
const fs = require('fs');
const path = require('path');

const PINTEREST_CLIENT_ID = process.env.PINTEREST_CLIENT_ID;
const PINTEREST_CLIENT_SECRET = process.env.PINTEREST_CLIENT_SECRET;
const PINTEREST_BOARD_ID = process.env.PINTEREST_BOARD_ID;
const BASE_URL = 'https://api.pinterest.com/v5';
const TOKEN_FILE = path.join(__dirname, '..', 'data', 'pinterest_token.json');

function envSeed() {
  const refresh = process.env.PINTEREST_REFRESH_TOKEN || null;
  return {
    access_token: process.env.PINTEREST_ACCESS_TOKEN || null,
    refresh_token: refresh,
    // With a refresh token, expires_at 0 forces a real refresh on first use.
    // Without one (a token pasted from the developer portal), trust it for
    // ~25 days; it will be rejected after ~30 and logged clearly.
    expires_at: refresh ? 0 : Date.now() + 25 * 24 * 3600 * 1000,
    seed_access: process.env.PINTEREST_ACCESS_TOKEN || null,
  };
}

function loadTokens() {
  if (fs.existsSync(TOKEN_FILE)) {
    const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    // If PINTEREST_ACCESS_TOKEN in Railway was changed since the saved file
    // was written, the new env token wins (this is how a dead token gets
    // replaced without having to delete the file by hand).
    const envToken = process.env.PINTEREST_ACCESS_TOKEN;
    if (envToken && saved.seed_access !== envToken) {
      console.log('🔑 New PINTEREST_ACCESS_TOKEN detected, replacing saved Pinterest tokens');
      return envSeed();
    }
    return saved;
  }
  return envSeed();
}

function saveTokens(tokens) {
  const dir = path.dirname(TOKEN_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ ...tokens, seed_access: process.env.PINTEREST_ACCESS_TOKEN || null }, null, 2));
}

async function refreshAccessToken(refreshToken) {
  if (!PINTEREST_CLIENT_ID || !PINTEREST_CLIENT_SECRET) {
    throw new Error('Missing PINTEREST_CLIENT_ID or PINTEREST_CLIENT_SECRET env vars (needed to refresh the Pinterest token)');
  }
  if (!refreshToken) {
    throw new Error('No Pinterest refresh token available (PINTEREST_REFRESH_TOKEN was never set)');
  }

  console.log('🔄 Refreshing Pinterest access token...');
  const res = await axios.post(
    `${BASE_URL}/oauth/token`,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      continuous_refresh: 'true',
    }).toString(),
    {
      auth: { username: PINTEREST_CLIENT_ID, password: PINTEREST_CLIENT_SECRET },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }
  );

  const tokens = {
    // Pinterest's continuous refresh tokens rotate on use; keep whatever
    // it hands back, but fall back to the one we sent if a run ever omits it.
    access_token: res.data.access_token,
    refresh_token: res.data.refresh_token || refreshToken,
    // Refresh 5 minutes early rather than cutting it exactly at expiry.
    expires_at: Date.now() + (res.data.expires_in - 300) * 1000,
  };
  saveTokens(tokens);
  console.log('✅ Pinterest access token refreshed');
  return tokens;
}

async function getValidAccessToken() {
  let tokens = loadTokens();

  const needsRefresh = !tokens.access_token || Date.now() >= (tokens.expires_at || 0);
  if (needsRefresh && tokens.access_token && !tokens.refresh_token) {
    console.warn('⚠️  Pinterest access token is past its expected expiry and there is no refresh token; trying it anyway');
  } else if (needsRefresh) {
    tokens = await refreshAccessToken(tokens.refresh_token);
  }
  return tokens.access_token;
}

async function createPin(listing, caption) {
  console.log('📌 Creating Pinterest pin...');

  if (!PINTEREST_BOARD_ID) {
    throw new Error('Missing PINTEREST_BOARD_ID env var');
  }

  const accessToken = await getValidAccessToken();

  const title = listing.title.length > 100
    ? listing.title.substring(0, 97) + '...'
    : listing.title;

  const description = caption.length > 500
    ? caption.substring(0, 497) + '...'
    : caption;

  const pinData = {
    board_id: PINTEREST_BOARD_ID,
    title,
    description,
    link: siteUrl('pinterest'),
    media_source: {
      source_type: 'image_url',
      url: listing.imageUrl
    }
  };

  const post = (token) => axios.post(`${BASE_URL}/pins`, pinData, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });

  try {
    const res = await post(accessToken);
    console.log(`✅ Pin created! Pin ID: ${res.data.id}`);
    return res.data.id;
  } catch (err) {
    // Belt-and-suspenders: if Pinterest rejects the token even though we
    // thought it was still valid (clock drift, manual revocation, a
    // rotated refresh token we didn't know about), force one refresh and
    // retry a single time before giving up.
    if (err.response && err.response.status === 401) {
      console.log('⚠️  Pinterest token rejected, forcing a refresh and retrying once...');
      const tokens = loadTokens();
      if (!tokens.refresh_token) {
        throw new Error('Pinterest rejected the access token and no PINTEREST_REFRESH_TOKEN is set; generate a new token in the Pinterest developer portal');
      }
      const refreshed = await refreshAccessToken(tokens.refresh_token);
      const res = await post(refreshed.access_token);
      console.log(`✅ Pin created on retry! Pin ID: ${res.data.id}`);
      return res.data.id;
    }
    throw err;
  }
}

module.exports = { createPin };
