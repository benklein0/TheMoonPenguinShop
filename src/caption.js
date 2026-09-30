// src/caption.js
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { readState, pushRecent, pickFresh, textFromMessage } = require('./state');
const { getHashtags } = require('./hashtags');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Rotating caption structures so posts don't all read the same way.
const CAPTION_STYLES = [
  { id: 'review', text: 'Lead with a short quote or paraphrase from the customer review, then introduce the piece.' },
  { id: 'detail', text: 'Open with one vivid visual detail of the piece, then say what it is.' },
  { id: 'use', text: 'Open with the everyday moment it is for (in your bag, on your nightstand, on the go), then the piece.' },
  { id: 'gift', text: 'Frame it as a gift for a specific kind of person.' },
  { id: 'maker', text: 'Open with how it is made (small-batch, brass set into resin by hand).' },
  { id: 'short', text: 'Keep it very short and punchy: two sentences.' },
];

// Handmade has to be prominent (mom's requirement), but the exact wording was
// getting repetitive ("lovingly handcrafted" on nearly every post).
const HANDMADE_PHRASES = [
  'made by hand', 'handmade in small batches', 'handcrafted one at a time',
  'handmade, so no two are exactly alike', 'set by hand', 'handmade in our studio',
  'a one-of-a-kind handmade piece',
];

function getRandomReview() {
  try {
    const reviewsPath = path.join(process.cwd(), 'reviews.json');
    const reviews = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
    const fiveStars = reviews.filter(r => r.stars === 5);
    return fiveStars[Math.floor(Math.random() * fiveStars.length)];
  } catch {
    return null;
  }
}

async function generateCaption(listing) {
  console.log(`✍️  Generating caption for: ${listing.title}`);

  const history = readState('caption_history', []);
  const style = pickFresh(CAPTION_STYLES, history.slice(-3).map(h => h.style));
  const handmade = pickFresh(HANDMADE_PHRASES, history.slice(-4).map(h => h.handmade));
  const recentOpenings = history.slice(-8).map(h => h.text.split(/\s+/).slice(0, 6).join(' '));
  const review = style.id === 'review' || Math.random() < 0.3 ? getRandomReview() : null;

  const prompt = `You are the social media manager for TheMoonPenguinShop, a handmade Etsy shop selling brass figural resin accessories (keychains, compact mirrors, pill boxes, bag hooks). Whimsical, feminine, artsy.

Write an Instagram Reels caption for:
Title: ${listing.title}
${listing.price ? `Price: ${listing.price}` : ''}
${listing.description ? `Description: ${listing.description.substring(0, 600)}` : ''}
${review ? `Customer review you may quote or paraphrase: "${review.text}" (${review.author})` : ''}

Structure: ${style.text}

Requirements:
- 2-4 sentences, under 300 characters.
- Make it clear it is handmade; work in this phrasing or a close variation: "${handmade}". Do NOT use "lovingly handcrafted".
- End with a natural call to action pointing to the link in bio (vary the wording).
- No URLs, no emojis, NO hashtags (those are added separately).
- Do not start like any of these recent captions:
${recentOpenings.length ? recentOpenings.map(o => `  - "${o}..."`).join('\n') : '  (none yet)'}

Return ONLY the caption text.`;

  const message = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 300,
    temperature: 1,
    messages: [{ role: 'user', content: prompt }],
  });

  // Strip any hashtags the model slipped in anyway; we add our own 5.
  const text = textFromMessage(message).replace(/(^|\s)#[A-Za-z0-9_]+/g, '').trim();
  pushRecent('caption_history', { style: style.id, handmade, text }, 20);

  const hashtags = await getHashtags(listing);
  const caption = `${text}\n\n${hashtags.join(' ')}`;
  console.log(`✅ Caption generated (${style.id}).`);
  return caption;
}

module.exports = { generateCaption };
