// src/etsyAuth.js
// Keeps the poster signed in to Etsy (OAuth, read-only listings access).
//
// scripts/etsy-auth.js produces a refresh token once; it goes in Railway
// as ETSY_REFRESH_TOKEN. Access tokens last an hour, so each use refreshes
// as needed and saves the result (including whatever refresh token Etsy
// hands back) to data/etsy_token.json on the volume. Refresh tokens last
// 90 days, and the hourly stock sync keeps renewing them.
//
// Same pattern as pinterest.js: if ETSY_REFRESH_TOKEN in Railway is changed
// (i.e. the sign-in script was run again), the new env token replaces the
// saved file.

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token';
const TOKEN_FILE = path.join(__dirname, '..', 'data', 'etsy_token.json');

function envSeed() {
  return {
    access_token: null,
    refresh_token: process.env.ETSY_REFRESH_TOKEN || null,
    expires_at: 0,
    seed_refresh: process.env.ETSY_REFRESH_TOKEN || null,
  };
}

function loadTokens() {
  if (fs.existsSync(TOKEN_FILE)) {
    const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    const envToken = process.env.ETSY_REFRESH_TOKEN;
    if (envToken && saved.seed_refresh !== envToken) {
      console.log('🔑 New ETSY_REFRESH_TOKEN detected, replacing saved Etsy sign-in');
      return envSeed();
    }
    return saved;
  }
  return envSeed();
}

function saveTokens(tokens) {
  const dir = path.dirname(TOKEN_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

function hasEtsySignIn() {
  return Boolean(process.env.ETSY_REFRESH_TOKEN || fs.existsSync(TOKEN_FILE));
}

async function getEtsyAccessToken() {
  const tokens = loadTokens();
  // Refresh a few minutes early so a token never expires mid-sync.
  if (tokens.access_token && Date.now() < tokens.expires_at - 5 * 60 * 1000) return tokens.access_token;
  if (!tokens.refresh_token) throw new Error('no ETSY_REFRESH_TOKEN set');

  let res;
  try {
    res = await axios.post(TOKEN_URL, new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.ETSY_API_KEY,
      refresh_token: tokens.refresh_token,
    }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000 });
  } catch (e) {
    const d = e.response?.data || {};
    throw new Error(`Etsy sign-in refresh failed (${d.error_description || d.error || e.message}) -- if it has expired, run scripts/etsy-auth.js again and update ETSY_REFRESH_TOKEN in Railway`);
  }

  const next = {
    access_token: res.data.access_token,
    refresh_token: res.data.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + res.data.expires_in * 1000,
    seed_refresh: tokens.seed_refresh,
  };
  saveTokens(next);
  return next.access_token;
}

module.exports = { getEtsyAccessToken, hasEtsySignIn };
