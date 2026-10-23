#!/usr/bin/env node
// scripts/etsy-auth.js
// One-time Etsy sign-in for the stock sync. Run it on your own computer:
//
//   node scripts/etsy-auth.js
//
// It opens Etsy's "allow access" page (read-only access to listings), you
// approve, Etsy sends you to themoonpenguinshop.com/etsy-callback.html,
// and you paste the code shown there back in here. The script prints an
// ETSY_REFRESH_TOKEN to put in Railway's variables. After that the poster
// keeps itself signed in (see src/etsyAuth.js); run this again only if the
// logs say the Etsy sign-in has expired.
//
// Before the first run, add this exact callback URL to the app on
// https://www.etsy.com/developers/your-apps:
//   https://themoonpenguinshop.com/etsy-callback.html
//
// No dependencies -- needs Node 18+ (built-in fetch).

const crypto = require('crypto');
const readline = require('readline');
const { execFile } = require('child_process');

const REDIRECT_URI = 'https://themoonpenguinshop.com/etsy-callback.html';
const SCOPES = ['listings_r'];
const TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token';

const base64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, answer => resolve(answer.trim())));
}

(async () => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // The keystring is the public half of the API key (the part before the
  // colon); it's also visible in the sign-in URL, so it isn't secret.
  let keystring = (process.env.ETSY_API_KEY || '').trim();
  if (!keystring) keystring = await ask(rl, 'Etsy app keystring (from etsy.com/developers/your-apps): ');
  if (!keystring) { console.error('No keystring given.'); process.exit(1); }

  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(12));

  const authUrl = 'https://www.etsy.com/oauth/connect?' + new URLSearchParams({
    response_type: 'code',
    client_id: keystring,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString().replace(/\+/g, '%20');

  console.log('\n1. Opening Etsy in your browser. If it does not open, visit:\n');
  console.log('   ' + authUrl + '\n');
  if (process.platform === 'darwin') execFile('open', [authUrl], () => {});
  console.log('2. Sign in as the shop owner and click "Grant access".');
  console.log('3. Copy the code shown on the Moon Penguin page and paste it below.\n');

  const pasted = await ask(rl, 'Code: ');
  rl.close();
  const [code, returnedState] = pasted.split(/\s+/);
  if (!code) { console.error('No code pasted.'); process.exit(1); }
  if (returnedState && returnedState !== state) {
    console.error('That code came from a different sign-in attempt. Run the script again and use the newest code.');
    process.exit(1);
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: keystring,
      redirect_uri: REDIRECT_URI,
      code,
      code_verifier: verifier,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.refresh_token) {
    console.error(`\nEtsy rejected the code (HTTP ${res.status}): ${body.error_description || body.error || JSON.stringify(body)}`);
    console.error('Codes expire quickly and work once -- run the script again for a fresh one.');
    process.exit(1);
  }

  console.log('\n✅ Signed in. In Railway → your service → Variables, set:\n');
  console.log(`   ETSY_REFRESH_TOKEN = ${body.refresh_token}\n`);
  console.log('Then deploy. The poster keeps the sign-in fresh from there.');
})().catch(e => { console.error(e); process.exit(1); });
