// src/stockSync.js
// Keeps the storefront's "in stock" status honest.
//
// docs/products.json is a one-time snapshot from when the shop page was
// built (April) -- nothing has ever updated it since, so a listing that
// sells out on Etsy and isn't auto-renewed just silently stays "in stock"
// and buyable on the site forever. (This is exactly how an order came in
// for "Red Resin Fox Pill Box: Stainless Steel Travel Medicine Organizer"
// on 2026-10-22 weeks after it was actually gone from Etsy.)
//
// Live listings come from the Etsy Open API (getListingsByShop with
// state=active, signed in as the shop owner -- see src/etsyAuth.js and
// scripts/etsy-auth.js). Needs ETSY_API_KEY (keystring), ETSY_SHARED_SECRET
// and ETSY_REFRESH_TOKEN in Railway. Signing in matters: key-only requests
// can't page past the first 100 listings, and the shop has more than that.
// A listing that's sold out or deactivated isn't "active", so "this product
// isn't among the active listings" means it's no longer purchasable.
//
// The feed is only pushed when the sold-out list changes (or once a day, so
// shop.html never sees it as stale), so running this hourly doesn't flood
// the stock branch with identical commits.
//
// This never touches docs/products.json or the main branch. It pushes a
// small {updated, outOfStock: [slug, ...]} file to a dedicated `stock`
// branch via the GitHub Contents API (needs a GITHUB_TOKEN with Contents
// read/write on this repo) -- same reasoning as Muse's hashtags branch:
// zero risk to the live product data or a GitHub Pages rebuild, and
// docs/shop.html fetches it client-side and overlays it onto inStock.
//
// If the API is unavailable (not signed in, Etsy down), we fall back to
// EtsyListingsDownload.csv at the repo root: Etsy's own "Download data"
// export of active listings (Shop Manager > Settings > Options > Download
// Data). Scraping the shop page is not an option -- Etsy's bot protection
// 403s it.
//
// Matching: a product counts as live if its title matches a live listing,
// or its main photo is that listing's main photo. Many listings
// have been retitled since products.json was built, and Etsy keeps the
// photo IDs across a retitle. Only the MAIN photo is used -- secondary
// photos are shared between color variants of the same design, so matching
// on them would keep sold-out variants "in stock".
const axios = require('axios');
const { getEtsyAccessToken, hasEtsySignIn } = require('./etsyAuth');
const fs = require('fs');
const path = require('path');

const ETSY_API = 'https://openapi.etsy.com/v3/application';
const SHOP_NAME = 'TheMoonPenguinShop';
const PRODUCTS_PATH = path.join(process.cwd(), 'docs', 'products.json');
const LISTINGS_CSV_PATH = path.join(process.cwd(), 'EtsyListingsDownload.csv');

const GITHUB_REPO = 'benklein0/TheMoonPenguinShop';
const STOCK_BRANCH = 'stock';
const STOCK_FILE_PATH = 'stock.json';
const FEED_REFRESH_MS = 1000 * 60 * 60 * 24; // re-push unchanged feed daily (shop.html rejects >4 days)

function normalizeTitle(t) {
  return (t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Etsy image URLs look like .../r/il/9e7caf/8040890546/il_fullxfull...;
// the numeric part is the photo's ID and survives a listing retitle.
function mainImageId(images) {
  const m = /\/il\/\w+\/(\d+)\//.exec(String(images || ''));
  return m ? m[1] : null;
}

async function etsyGet(pathname, params) {
  return axios.get(`${ETSY_API}${pathname}`, {
    params,
    headers: {
      'x-api-key': `${process.env.ETSY_API_KEY}:${process.env.ETSY_SHARED_SECRET}`,
      Authorization: `Bearer ${await getEtsyAccessToken()}`,
    },
    // Etsy wants array params as a comma list (includes=Images,Shop).
    paramsSerializer: p => new URLSearchParams(
      Object.entries(p).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)])
    ).toString(),
    timeout: 20000,
  });
}

let cachedShopId = process.env.ETSY_SHOP_ID || null;
async function getShopId() {
  if (cachedShopId) return cachedShopId;
  const res = await etsyGet('/shops', { shop_name: SHOP_NAME });
  const shop = (res.data.results || []).find(s => s.shop_name.toLowerCase() === SHOP_NAME.toLowerCase());
  if (!shop) throw new Error(`shop "${SHOP_NAME}" not found`);
  cachedShopId = shop.shop_id;
  return cachedShopId;
}

// Every active listing's title + main photo ID, straight from Etsy.
async function fetchActiveListings() {
  const shopId = await getShopId();
  const titles = new Set();
  const mainImages = new Set();
  let seen = 0;
  let total = null;
  for (let offset = 0; ; offset += 100) {
    const res = await etsyGet(`/shops/${shopId}/listings`, {
      state: 'active', limit: 100, offset, sort_on: 'created', sort_order: 'asc', includes: ['Images'],
    });
    total = res.data.count;
    const page = res.data.results || [];
    seen += page.length;
    for (const l of page) {
      if (l.state !== 'active' || l.quantity <= 0) continue;
      titles.add(normalizeTitle(l.title));
      const main = (l.images || []).slice().sort((a, b) => a.rank - b.rank)[0];
      if (main) mainImages.add(String(main.listing_image_id));
    }
    if (page.length < 100 || seen >= total) break;
  }
  if (seen < total) throw new Error(`only received ${seen} of ${total} active listings`);
  return { titles, mainImages };
}

// Minimal RFC 4180 parser: quoted fields may contain commas, newlines and
// doubled quotes (Etsy's DESCRIPTION column has all three).
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v !== ''));
}

// Reads Etsy's listings export and returns the live titles + main photos.
function readListingsCsv() {
  const [header, ...rows] = parseCsv(fs.readFileSync(LISTINGS_CSV_PATH, 'utf8').replace(/^\uFEFF/, ''));
  const col = name => header.indexOf(name);
  const [iTitle, iQty, iImage] = [col('TITLE'), col('QUANTITY'), col('IMAGE1')];
  if (iTitle < 0 || iImage < 0) throw new Error('missing TITLE/IMAGE1 columns');
  const titles = new Set();
  const mainImages = new Set();
  for (const r of rows) {
    if (iQty >= 0 && Number(r[iQty]) <= 0) continue; // exported but none left
    titles.add(normalizeTitle(r[iTitle]));
    const img = mainImageId(r[iImage]);
    if (img) mainImages.add(img);
  }
  return { titles, mainImages };
}

async function githubRequest(method, url, token, data, params) {
  return axios({
    method,
    url,
    data,
    params,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
}

async function getStockFile(token) {
  try {
    const res = await githubRequest(
      'get',
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${STOCK_FILE_PATH}`,
      token,
      undefined,
      { ref: STOCK_BRANCH }
    );
    const content = JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'));
    return { sha: res.data.sha, content };
  } catch (e) {
    if (e.response && e.response.status === 404) return { sha: null, content: null }; // file or branch doesn't exist yet
    throw e;
  }
}

async function ensureStockBranch(token) {
  try {
    await githubRequest('get', `https://api.github.com/repos/${GITHUB_REPO}/git/ref/heads/${STOCK_BRANCH}`, token);
    return; // already exists
  } catch (e) {
    if (!e.response || e.response.status !== 404) throw e;
  }
  const mainRef = await githubRequest('get', `https://api.github.com/repos/${GITHUB_REPO}/git/ref/heads/main`, token);
  await githubRequest('post', `https://api.github.com/repos/${GITHUB_REPO}/git/refs`, token, {
    ref: `refs/heads/${STOCK_BRANCH}`,
    sha: mainRef.data.object.sha,
  });
  console.log(`🌿 Created "${STOCK_BRANCH}" branch for the stock feed`);
}

// Returns false (and pushes nothing) when the published feed already has
// the same sold-out list and is fresh enough.
async function pushStockFile(token, content) {
  await ensureStockBranch(token);
  const { sha, content: current } = await getStockFile(token);
  if (current && Array.isArray(current.outOfStock)) {
    const same = current.outOfStock.length === content.outOfStock.length &&
      [...current.outOfStock].sort().join('\n') === [...content.outOfStock].sort().join('\n');
    const age = Date.now() - Date.parse(current.updated);
    if (same && age >= 0 && age < FEED_REFRESH_MS) return false;
  }
  await githubRequest('put', `https://api.github.com/repos/${GITHUB_REPO}/contents/${STOCK_FILE_PATH}`, token, {
    message: `Update stock feed (${content.outOfStock.length} sold out)`,
    content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
    branch: STOCK_BRANCH,
    sha: sha || undefined,
  });
  return true;
}

async function runStockSync() {
  if (!process.env.GITHUB_TOKEN) {
    console.warn('⚠️  Stock sync skipped: GITHUB_TOKEN not set');
    return;
  }

  console.log('📦 Checking Etsy stock status...');
  let products;
  try {
    products = JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf8'));
  } catch (e) {
    console.warn('⚠️  Stock sync: could not read docs/products.json:', e.message);
    return;
  }

  let active;
  let source;
  if (process.env.ETSY_API_KEY && process.env.ETSY_SHARED_SECRET && hasEtsySignIn()) {
    try {
      active = await fetchActiveListings();
      source = 'Etsy API';
    } catch (e) {
      const detail = e.response?.data?.error || e.message;
      console.warn(`⚠️  Stock sync: Etsy API failed (${detail}), using EtsyListingsDownload.csv`);
    }
  } else {
    console.warn('⚠️  Stock sync: Etsy not connected (needs ETSY_API_KEY, ETSY_SHARED_SECRET and ETSY_REFRESH_TOKEN -- see scripts/etsy-auth.js), using EtsyListingsDownload.csv');
  }
  if (!active) {
    try {
      active = readListingsCsv();
      source = 'EtsyListingsDownload.csv';
    } catch (csvErr) {
      console.warn('⚠️  Stock sync: could not read EtsyListingsDownload.csv, skipping this run:', csvErr.message);
      return;
    }
  }

  // Sanity check: if the source came back suspiciously thin (a partial API
  // response, a truncated export, etc.),
  // refuse to publish a feed that would wrongly mark a huge chunk of the
  // catalog "sold out".
  const minExpected = Math.floor(products.length * 0.5);
  if (active.titles.size < minExpected) {
    console.warn(`⚠️  Stock sync: only found ${active.titles.size} active listings in ${source} (expected at least ${minExpected}) -- looks wrong, skipping this run`);
    return;
  }

  const outOfStock = products
    .filter(p => !active.titles.has(normalizeTitle(p.title)) && !active.mainImages.has(mainImageId(p.images)))
    .map(p => p.slug);

  console.log(`📦 Stock sync (${source}): ${outOfStock.length} of ${products.length} products look sold out`);

  const payload = { updated: new Date().toISOString(), outOfStock };

  try {
    const pushed = await pushStockFile(process.env.GITHUB_TOKEN, payload);
    console.log(pushed ? '✅ Stock feed pushed to the "stock" branch' : '✅ Stock feed unchanged, nothing to push');
  } catch (e) {
    console.warn('⚠️  Stock sync: failed to push feed:', e.response?.data?.message || e.message);
  }
}

module.exports = { runStockSync, normalizeTitle, readListingsCsv, mainImageId };
