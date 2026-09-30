// src/rss.js
const RSSParser = require('rss-parser');
const axios = require('axios');
const parser = new RSSParser({
  customFields: {
    item: [
      'media:content',
      'media:thumbnail',
      'g:price',
      ['content:encoded', 'content'],
      'description'
    ]
  }
});

const FEED_URL = 'https://www.etsy.com/shop/TheMoonPenguinShop/rss';
const DATA_FILE = './data/listings.json';
const fs = require('fs');

// Data structure:
// { posted: [id, ...], seen: [id, ...] }
// posted = actually published to Instagram
// seen = appeared in RSS feed (to detect "new" vs "backlog")

function loadData() {
  try {
    if (!fs.existsSync('./data')) fs.mkdirSync('./data', { recursive: true });
    if (!fs.existsSync(DATA_FILE)) return { posted: [], seen: [] };
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch { return { posted: [], seen: [] }; }
}

function saveData(data) {
  if (!fs.existsSync('./data')) fs.mkdirSync('./data', { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function getListingId(url) {
  const match = url.match(/\/listing\/(\d+)\//);
  return match ? match[1] : null;
}

async function scrapeImageFromListing(url) {
  console.log('   🔍 Fetching image...');

  // Attempt 1: Etsy open API (no auth needed for public listings)
  try {
    const listingId = getListingId(url);
    if (listingId) {
      const apiRes = await axios.get(
        `https://openapi.etsy.com/v3/application/listings/${listingId}/images`,
        { headers: { 'x-api-key': 'aias9ed2s4qvl1ynfggg7b6w' }, timeout: 8000 }
      );
      const imgUrl = apiRes.data?.results?.[0]?.url_fullxfull;
      if (imgUrl) { console.log('   ✅ Image found via Etsy API'); return imgUrl; }
    }
  } catch {}

  // Attempt 2: mobile scrape with google referer
  const userAgents = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  ];

  for (let attempt = 0; attempt < userAgents.length; attempt++) {
    try {
      const delay = 2000 + attempt * 3000 + Math.random() * 2000;
      await new Promise(r => setTimeout(r, delay));
      const res = await axios.get(url, {
        headers: {
          'User-Agent': userAgents[attempt],
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'cross-site',
          'Referer': 'https://www.google.com/',
          'Cache-Control': 'max-age=0'
        },
        timeout: 15000
      });
      const ogMatch = res.data.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/);
      if (ogMatch) { console.log('   ✅ Image found via page scrape'); return ogMatch[1]; }
    } catch (e) {
      console.log(`   Attempt ${attempt + 1} failed (${e.message}), retrying...`);
    }
  }

  console.warn('   ⚠️  Could not fetch image after all attempts');
  return null;
}

async function scrapePriceFromListing(url) {
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Referer': 'https://www.google.com/'
      },
      timeout: 10000
    });
    const priceMatch = res.data.match(/<meta[^>]+property="product:price:amount"[^>]+content="([^"]+)"/);
    if (priceMatch) return `$${parseFloat(priceMatch[1]).toFixed(2)}`;
    const jsonLdMatch = res.data.match(/"price":\s*"?([\d.]+)"?/);
    if (jsonLdMatch) return `$${parseFloat(jsonLdMatch[1]).toFixed(2)}`;
    return null;
  } catch { return null; }
}

function itemToListing(item) {
  let imageUrl = null;

  // Try standard RSS image fields
  if (item['media:content']?.['$']?.url) imageUrl = item['media:content']['$'].url;
  else if (item['media:thumbnail']?.['$']?.url) imageUrl = item['media:thumbnail']['$'].url;
  else if (item.enclosure?.url) imageUrl = item.enclosure.url;

  // Try parsing image from description/content HTML (Etsy embeds <img> tags)
  if (!imageUrl) {
    const html = item.content || item['content:encoded'] || item.description || '';
    const imgMatch = html.match(/<img[^>]+src=["']([^"']+etsystatic[^"']+)["']/i);
    if (imgMatch) {
      // Upgrade to full resolution
      imageUrl = imgMatch[1].replace(/il_\d+xN/, 'il_fullxfull').replace(/il_\d+x\d+/, 'il_fullxfull');
    }
  }

  // Try link field - construct etsystatic URL from listing ID
  // Etsy CDN pattern: we can try to get the shop's images via a known pattern
  if (!imageUrl) {
    const listingIdMatch = (item.link || '').match(/\/listing\/(\d+)\//);
    if (listingIdMatch) {
      // Store listing ID for later use
      item._listingId = listingIdMatch[1];
    }
  }

  let price = null;
  // Try to get price from content HTML
  const html = item.content || item['content:encoded'] || item.description || '';
  const priceMatch = html.match(/\$([\d,]+\.\d{2})/);
  if (priceMatch) price = `$${priceMatch[1]}`;

  const title = item.title ? item.title.replace(/\s+by TheMoonPenguinShop$/, '').trim() : 'New Item';

  return {
    id: item.guid || item.link,
    title,
    price,
    imageUrl,
    listingUrl: item.link,
    description: item.contentSnippet || '',
    pubDate: item.pubDate || null,
    _listingId: item._listingId || null
  };
}

// Get next listing to post:
// Priority 1 — listings new since last run (appeared in feed for first time)
// Priority 2 — oldest listing in feed that hasn't been posted yet
async function getNextListing() {
  console.log('📡 Fetching Etsy RSS feed...');
  const feed = await parser.parseURL(FEED_URL);
  const data = loadData();

  const allItems = feed.items.map(itemToListing);
  const allIds = allItems.map(i => i.id);

  // Mark all current feed items as seen (but not posted)
  const newlySeenIds = allIds.filter(id => !data.seen.includes(id));
  data.seen = [...new Set([...data.seen, ...allIds])].slice(-200);

  // Find unposted listings — prioritize newly seen first, then oldest unposted
  // Etsy admin listings (reshipping fees, deposits, custom-order slots...)
  // aren't products and should never become reels. Mark them done so they
  // can't block the queue.
  const NOT_A_PRODUCT = /re-?ship|shipping (cost|fee|upgrade)|custom order|deposit|reserved for|gift ?card|payment|balance due|additional cost/i;
  const skipped = allItems.filter(i => NOT_A_PRODUCT.test(i.title) && !data.posted.includes(i.id));
  if (skipped.length) {
    skipped.forEach(i => console.log(`⏭️  Skipping non-product listing: ${i.title}`));
    data.posted = [...data.posted, ...skipped.map(i => i.id)].slice(-500);
  }

  const unposted = allItems.filter(item => !data.posted.includes(item.id));

  if (unposted.length === 0) {
    console.log('💤 All listings in feed have already been posted.');
    saveData(data);
    return null;
  }

  // Priority 1: newly seen listings (brand new to feed)
  const newListings = unposted.filter(item => newlySeenIds.includes(item.id));
  // Priority 2: older unposted listings (reverse feed order = oldest first)
  const backlog = unposted.filter(item => !newlySeenIds.includes(item.id)).reverse();

  const candidate = newListings.length > 0 ? newListings[0] : backlog[0];
  const isNew = newListings.length > 0;

  console.log(`${isNew ? '🆕 New listing' : '📦 Backlog listing'}: ${candidate.title}`);

  // Fetch image and price if missing
  if (!candidate.imageUrl) {
    candidate.imageUrl = await scrapeImageFromListing(candidate.listingUrl);
  }
  if (!candidate.price) {
    candidate.price = await scrapePriceFromListing(candidate.listingUrl);
  }

  saveData(data);
  return candidate;
}

// Call this after successfully posting to mark as posted
function markAsPosted(listingId) {
  const data = loadData();
  if (!data.posted.includes(listingId)) {
    data.posted = [...data.posted, listingId].slice(-500);
    saveData(data);
  }
}

module.exports = { getNextListing, markAsPosted };
