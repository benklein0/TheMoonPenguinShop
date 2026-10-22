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
// There's no Etsy API access for this (same reason rss.js and the review
// scraper work by scraping instead of calling an API), so this scrapes the
// shop's own listing grid pages. Confirmed by hand against the real shop:
// a listing that's sold out and not auto-renewing is simply OMITTED from
// the grid entirely -- Etsy does not render a "sold out" card for it. So
// "this product's title isn't in the current grid" is a reliable signal
// that it's no longer purchasable.
//
// This never touches docs/products.json or the main branch. It pushes a
// small {updated, outOfStock: [slug, ...]} file to a dedicated `stock`
// branch via the GitHub Contents API (needs a GITHUB_TOKEN with Contents
// read/write on this repo) -- same reasoning as Muse's hashtags branch:
// zero risk to the live product data or a GitHub Pages rebuild, and
// docs/shop.html fetches it client-side and overlays it onto inStock.
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const SHOP_URL = 'https://www.etsy.com/shop/TheMoonPenguinShop';
const MAX_PAGES = 12; // safety cap -- the shop currently runs ~7 pages of active listings
const PRODUCTS_PATH = path.join(process.cwd(), 'docs', 'products.json');

const GITHUB_REPO = 'benklein0/TheMoonPenguinShop';
const STOCK_BRANCH = 'stock';
const STOCK_FILE_PATH = 'stock.json';

const USER_AGENTS = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

function normalizeTitle(t) {
  return (t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchShopPage(pageNum) {
  const url = pageNum === 1 ? SHOP_URL : `${SHOP_URL}?page=${pageNum}`;
  const ua = USER_AGENTS[pageNum % USER_AGENTS.length];
  const res = await axios.get(url, {
    headers: {
      'User-Agent': ua,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Referer': 'https://www.google.com/',
    },
    timeout: 15000,
  });
  return res.data;
}

// Each active listing card renders its title as:
//   <h3 class="... v2-listing-card__title ..." id="listing-title-<id>">TITLE</h3>
// (confirmed against the real shop page, Oct 2026).
function parseListingTitles(html) {
  const titles = [];
  const re = /class="[^"]*v2-listing-card__title[^"]*"[^>]*>([\s\S]*?)<\/h3>/g;
  let m;
  while ((m = re.exec(html))) {
    const title = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (title) titles.push(title);
  }
  return titles;
}

// Scrapes every page of the shop's active listing grid and returns the set
// of normalized titles that are currently live.
async function scrapeActiveListingTitles() {
  const active = new Set();
  let sawAnyPage = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    let html;
    try {
      html = await fetchShopPage(page);
    } catch (e) {
      if (!sawAnyPage) throw e; // first page failed outright -- give up loudly
      console.warn(`⚠️  Stock sync: page ${page} fetch failed (${e.message}), stopping there`);
      break;
    }
    const titles = parseListingTitles(html);
    if (titles.length === 0) break; // ran past the last page
    sawAnyPage = true;
    titles.forEach(t => active.add(normalizeTitle(t)));
    await sleep(1500 + Math.random() * 1500); // be polite between pages
  }
  return active;
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

async function getStockFileSha(token) {
  try {
    const res = await githubRequest(
      'get',
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${STOCK_FILE_PATH}`,
      token,
      undefined,
      { ref: STOCK_BRANCH }
    );
    return res.data.sha;
  } catch (e) {
    if (e.response && e.response.status === 404) return null; // file or branch doesn't exist yet
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

async function pushStockFile(token, content) {
  await ensureStockBranch(token);
  const sha = await getStockFileSha(token);
  await githubRequest('put', `https://api.github.com/repos/${GITHUB_REPO}/contents/${STOCK_FILE_PATH}`, token, {
    message: `Update stock feed (${content.outOfStock.length} sold out)`,
    content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
    branch: STOCK_BRANCH,
    sha: sha || undefined,
  });
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
  try {
    active = await scrapeActiveListingTitles();
  } catch (e) {
    console.warn('⚠️  Stock sync: could not reach Etsy, skipping this run:', e.message);
    return;
  }

  // Sanity check: if the scrape came back suspiciously thin (Etsy changed
  // its markup, got rate-limited after one page, etc.), refuse to publish a
  // feed that would wrongly mark a huge chunk of the catalog "sold out".
  const minExpected = Math.floor(products.length * 0.5);
  if (active.size < minExpected) {
    console.warn(`⚠️  Stock sync: only found ${active.size} active listings (expected at least ${minExpected}) -- looks wrong, skipping this run`);
    return;
  }

  const outOfStock = products
    .filter(p => !active.has(normalizeTitle(p.title)))
    .map(p => p.slug);

  console.log(`📦 Stock sync: ${outOfStock.length} of ${products.length} products look sold out`);

  const payload = { updated: new Date().toISOString(), outOfStock };

  try {
    await pushStockFile(process.env.GITHUB_TOKEN, payload);
    console.log('✅ Stock feed pushed to the "stock" branch');
  } catch (e) {
    console.warn('⚠️  Stock sync: failed to push feed:', e.response?.data?.message || e.message);
  }
}

module.exports = { runStockSync, normalizeTitle };
