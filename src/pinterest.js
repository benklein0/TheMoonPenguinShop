// src/pinterest.js
// Posts product pins to Pinterest via the Pinterest API v5

const axios = require('axios');

const PINTEREST_ACCESS_TOKEN = process.env.PINTEREST_ACCESS_TOKEN;
const PINTEREST_BOARD_ID = process.env.PINTEREST_BOARD_ID;
const BASE_URL = 'https://api.pinterest.com/v5';

async function createPin(listing, caption) {
  console.log('📌 Creating Pinterest pin...');

  if (!PINTEREST_ACCESS_TOKEN || !PINTEREST_BOARD_ID) {
    throw new Error('Missing PINTEREST_ACCESS_TOKEN or PINTEREST_BOARD_ID env vars');
  }

  // Extract just the caption text without hashtags for the pin title
  const lines = caption.split('\n').filter(l => l.trim());
  const title = listing.title.length > 100
    ? listing.title.substring(0, 97) + '...'
    : listing.title;

  // Description: caption text + listing URL + hashtags
  const description = caption.length > 500
    ? caption.substring(0, 497) + '...'
    : caption;

  const pinData = {
    board_id: PINTEREST_BOARD_ID,
    title,
    description,
    link: listing.listingUrl,
    media_source: {
      source_type: 'image_url',
      url: listing.imageUrl
    }
  };

  const res = await axios.post(`${BASE_URL}/pins`, pinData, {
    headers: {
      'Authorization': `Bearer ${PINTEREST_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });

  console.log(`✅ Pin created! Pin ID: ${res.data.id}`);
  return res.data.id;
}

module.exports = { createPin };
