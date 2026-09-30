// src/hashtags.js
// Picks hashtags for each post.
//
// Instagram now caps posts and Reels at 5 hashtags, so the old "15-20 tags"
// approach wastes most of them. Instead we pick 5 targeted ones:
//   1. #themoonpenguinshop (brand, always)
//   2-5. Chosen per product by Claude from a candidate pool made of
//        (a0) Meta Muse's daily trending-tag file (hashtags branch), then
//        (a) currently-trending tags researched with web search, refreshed
//            every few days and cached on the ./data volume,
//        (b) seasonal tags for the current month, and
//        (c) an evergreen niche pool,
//        while avoiding the tags used in the last few posts.

const Anthropic = require('@anthropic-ai/sdk');
const { readState, writeState, pushRecent, textFromMessage } = require('./state');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const HASHTAG_LIMIT = parseInt(process.env.HASHTAG_LIMIT || '5', 10);
const BRAND_TAG = '#themoonpenguinshop';
const TRENDING_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // refresh every 3 days

const EVERGREEN = [
  '#handmadejewelry', '#handmadegifts', '#resinart', '#brassjewelry', '#etsyfinds',
  '#etsyshop', '#shopsmall', '#smallbusiness', '#handmade', '#uniquegifts',
  '#cottagecore', '#darkacademia', '#witchyvibes', '#whimsical', '#vintageaesthetic',
  '#pillbox', '#pillcase', '#compactmirror', '#pocketmirror', '#baghook', '#pursehook',
  '#keychain', '#giftsforher', '#animaljewelry', '#catlover', '#foxlover', '#frogcore',
  '#maximalism', '#curiosities', '#madeinconnecticut', '#giftideas', '#accessories',
];

const SEASONAL = {
  1: ['#newyearnewme', '#wintervibes', '#selfcare'],
  2: ['#valentinesgift', '#galentines', '#giftsforher'],
  3: ['#springvibes', '#springstyle', '#mothersdaygift'],
  4: ['#springvibes', '#mothersdaygift', '#easter'],
  5: ['#mothersdaygift', '#graduationgift', '#summerstyle'],
  6: ['#summerstyle', '#fathersdaygift', '#travelessentials'],
  7: ['#summerstyle', '#travelessentials', '#summervibes'],
  8: ['#backtoschool', '#darkacademia', '#fallvibes'],
  9: ['#fallvibes', '#autumnaesthetic', '#spookyseason', '#halloween'],
  10: ['#spookyseason', '#halloween', '#fallvibes', '#witchyvibes', '#autumnaesthetic'],
  11: ['#giftguide', '#smallbusinesssaturday', '#holidaygifts', '#blackfriday', '#shopsmall'],
  12: ['#stockingstuffers', '#christmasgifts', '#holidaygifts', '#giftguide', '#secretsanta'],
};

function normalize(tag) {
  const t = String(tag).trim().toLowerCase().replace(/[^#a-z0-9_]/g, '');
  if (!t) return null;
  return t.startsWith('#') ? t : `#${t}`;
}

// Research tags that are actually trending right now for this niche.
// Uses Claude's web search tool; if that isn't enabled on the API key or
// anything goes wrong, we just fall back to seasonal + evergreen tags.
async function refreshTrending() {
  const month = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'America/New_York' });
  console.log(`🔎 Researching trending hashtags for ${month}...`);

  const message = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 2000,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
    messages: [{
      role: 'user',
      content: `Search the web for Instagram hashtags that are trending or seeing strong engagement right now (${month}) for a small handmade accessories shop: brass animal figures set in resin on pill boxes, compact mirrors, bag hooks and keychains. Aesthetic: whimsical, witchy, cottagecore, dark academia, vintage. Include relevant seasonal/holiday tags for the coming weeks, gift-shopping tags, and niche aesthetic tags. Prefer mid-sized, specific tags over giant generic ones like #love or #instagood, and skip banned or spammy tags.

Return ONLY a JSON object, no prose: {"tags": ["#tag1", "#tag2", ...]} with 25-40 tags.`,
    }],
  });

  const text = textFromMessage(message);
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in trending hashtag response');
  const tags = [...new Set((JSON.parse(match[0]).tags || []).map(normalize).filter(Boolean))];
  if (tags.length < 5) throw new Error(`Only ${tags.length} trending tags returned`);

  writeState('trending_hashtags', { fetchedAt: Date.now(), month, tags });
  console.log(`✅ ${tags.length} trending hashtags cached: ${tags.slice(0, 10).join(' ')} ...`);
  return tags;
}

// Daily hashtag research pushed by Meta Muse to the `hashtags` branch
// (never `main`, so it doesn't trigger a Railway redeploy). Format:
//   {"date":"YYYY-MM-DD","slots":{"09":[...],"13":[...],"17":[...]}}
// Returns [] if the file is missing, malformed or more than 2 days old.
const MUSE_URL = process.env.MUSE_HASHTAG_URL ||
  'https://raw.githubusercontent.com/benklein0/TheMoonPenguinShop/hashtags/hashtags.json';
const MUSE_MAX_AGE_DAYS = 2;

async function getMuseTags() {
  try {
    const res = await fetch(MUSE_URL, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const ageDays = (Date.parse(todayET) - Date.parse(data.date)) / 86400000;
    if (!(ageDays >= 0 && ageDays <= MUSE_MAX_AGE_DAYS)) throw new Error(`stale or bad date: ${data.date}`);
    const tags = [...new Set(Object.values(data.slots || {}).flat()
      .filter(t => typeof t === 'string' && /^#?[A-Za-z0-9_]{2,40}$/.test(t.trim()))
      .map(normalize).filter(Boolean))].slice(0, 30);
    if (tags.length < 3) throw new Error(`only ${tags.length} usable tags`);
    console.log(`🧠 Muse hashtags (${data.date}): ${tags.length} tags`);
    return tags;
  } catch (err) {
    console.warn('⚠️  Muse hashtag file unavailable (using own research):', err.message);
    return [];
  }
}

let inflight = null; // avoid two simultaneous web searches (startup + first post)
async function getTrendingTags() {
  // Muse's fresh daily file comes first; our own (3-day cached) research fills
  // in behind it. If Muse is fresh we don't spend a web search refreshing ours.
  const muse = await getMuseTags();
  const cachedOwn = readState('trending_hashtags', null);
  if (muse.length) return [...new Set([...muse, ...(cachedOwn?.tags || [])])];
  return getOwnTrendingTags();
}

async function getOwnTrendingTags() {
  const cached = readState('trending_hashtags', null);
  if (cached && cached.tags && Date.now() - cached.fetchedAt < TRENDING_MAX_AGE_MS) {
    return cached.tags;
  }
  if (!inflight) {
    inflight = refreshTrending()
      .catch(err => {
        console.warn('⚠️  Trending hashtag refresh failed (using fallback pool):', err.message);
        return cached?.tags || [];
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

async function getHashtags(listing) {
  const month = new Date().getMonth() + 1;
  const trending = await getTrendingTags();
  const seasonal = SEASONAL[month] || [];
  const recent = readState('recent_hashtags', []).flat();

  const pool = [...new Set([...trending, ...seasonal, ...EVERGREEN].map(normalize).filter(Boolean))]
    .filter(t => t !== BRAND_TAG);
  const slots = Math.max(0, HASHTAG_LIMIT - 1);

  let chosen = [];
  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Pick exactly ${slots} Instagram hashtags for this product post from the candidate list.

Product: ${listing.title}
${listing.description ? `Description: ${listing.description.substring(0, 400)}` : ''}

Candidates (the first ${trending.length} are currently trending): ${pool.join(' ')}

Rules:
- At least one must describe the product itself (type of item or the animal/charm).
- At least one should be a currently trending or seasonal tag if any fit.
- Avoid these recently used tags unless nothing else fits: ${[...new Set(recent)].join(' ') || '(none)'}
- You may add ONE tag not in the list if it is a clearly better, specific match for this product.

Return ONLY the hashtags separated by spaces.`,
      }],
    });
    chosen = (textFromMessage(message).match(/#[A-Za-z0-9_]+/g) || []).map(normalize);
  } catch (err) {
    console.warn('⚠️  Hashtag selection failed, picking randomly:', err.message);
  }

  if (chosen.length < slots) {
    const fallback = pool.filter(t => !recent.includes(t) && !chosen.includes(t)).sort(() => Math.random() - 0.5);
    chosen = [...chosen, ...fallback].slice(0, slots);
  }

  const tags = [BRAND_TAG, ...[...new Set(chosen)].filter(t => t !== BRAND_TAG).slice(0, slots)];
  pushRecent('recent_hashtags', tags.slice(1), 3);
  console.log(`🏷️  Hashtags: ${tags.join(' ')}`);
  return tags;
}

module.exports = { getHashtags, getTrendingTags, refreshTrending };
