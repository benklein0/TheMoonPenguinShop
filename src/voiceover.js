// src/voiceover.js
// Writes a voiceover script with Claude (varied angle + tone every time, with
// a banned-phrase filter and a memory of recent openings), then voices it
// with ElevenLabs.

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { readState, pushRecent, pickFresh, textFromMessage } = require('./state');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'gsm4lUH9bnZ3pjR1Pw7w'; // Claire
const OUTPUT_DIR = './tmp';

// Phrases the scripts kept leaning on. Checked case-insensitively after
// generation; a script that uses any of them is regenerated.
const BANNED_PHRASES = [
  'oh my gosh', 'oh my god', 'omg', 'oh my goodness', 'oh wow',
  'you need to see', 'you have to see', 'i just found', 'i found this',
  'look at this', 'obsessed', 'literally', 'you guys', 'okay so',
  'ok so', 'stop scrolling', 'can we talk about', 'hear me out',
];

// Each script gets one angle (what the script is about) ...
const ANGLES = [
  { id: 'gift', text: 'Frame it as a gift idea: who in your life this is perfect for, and why it beats a generic gift.' },
  { id: 'maker', text: 'Focus on how it is made: small-batch, by hand, brass figure set into resin, no two exactly alike.' },
  { id: 'everyday', text: 'Paint a quick everyday moment where this piece gets used (in a bag, on a desk, at the table), then name what it is.' },
  { id: 'detail', text: 'Zoom in on one or two specific visual details (the color of the resin, the little brass figure, the finish) like a slow close-up.' },
  { id: 'question', text: 'Open with a short, genuine question to the viewer that the product answers. Not clickbait.' },
  { id: 'review', text: 'Build it around what a real customer said (provided below). Quote or paraphrase briefly and attribute it to "a customer".' },
  { id: 'three', text: 'Give three quick reasons to love it, in a natural spoken rhythm (not "number one, number two").' },
  { id: 'story', text: 'Tell a tiny whimsical story about the animal or charm on the piece, then land on the product.' },
  { id: 'practical', text: 'Be practical and clear: what it is, what it holds or does, size or feel, and why it is handy. Warm but no hype.' },
  { id: 'aesthetic', text: 'Describe the vibe or aesthetic it fits (cottagecore, dark academia, witchy, vintage, maximalist) and the kind of person who would love it.' },
];

// ... and one delivery tone.
const TONES = [
  { id: 'cozy', text: 'calm, cozy and soft, like a quiet recommendation', style: 0.2 },
  { id: 'playful', text: 'playful and lightly witty, with a little charm', style: 0.45 },
  { id: 'dreamy', text: 'dreamy and descriptive, unhurried', style: 0.25 },
  { id: 'confident', text: 'confident and polished, like a boutique owner describing a favorite piece', style: 0.3 },
  { id: 'friendly', text: 'friendly and down-to-earth, plain words, no hype', style: 0.3 },
];

const CTAS = [
  'Link in bio.',
  'It is in the shop now, link in bio.',
  'Tap the link in our bio to see it.',
  'Find it at TheMoonPenguinShop, link in bio.',
  'Shop it through the link in bio.',
  'Available now at the link in bio.',
  'Details are at the link in bio.',
];

function getRandomReview() {
  try {
    const reviews = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'reviews.json'), 'utf8'));
    const fiveStars = reviews.filter(r => r.stars === 5 && r.text.length < 220);
    return fiveStars[Math.floor(Math.random() * fiveStars.length)];
  } catch {
    return null;
  }
}

function findBanned(script) {
  const lower = script.toLowerCase();
  return BANNED_PHRASES.filter(p => new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower));
}

function firstWords(script, n = 6) {
  return script.split(/\s+/).slice(0, n).join(' ');
}

let lastTone = null; // exposed to generateVoiceover so the voice matches

async function generateVoiceoverScript(listing) {
  console.log('📝 Generating voiceover script...');

  const history = readState('voiceover_history', []);
  const recentAngles = history.slice(-4).map(h => h.angle);
  const recentTones = history.slice(-2).map(h => h.tone);
  const recentOpenings = history.slice(-10).map(h => firstWords(h.script));
  const recentCtas = history.slice(-3).map(h => h.cta);

  const review = getRandomReview();
  let angle = pickFresh(ANGLES, recentAngles);
  if (angle.id === 'review' && !review) angle = ANGLES.find(a => a.id === 'detail');
  const tone = pickFresh(TONES, recentTones);
  const cta = pickFresh(CTAS, recentCtas);
  lastTone = tone;
  console.log(`   Angle: ${angle.id} | Tone: ${tone.id}`);

  const prompt = `Write a short voiceover script for a ~15-second Instagram Reel for TheMoonPenguinShop, a small handmade accessories shop (brass figures set in resin: pill boxes, compact mirrors, bag hooks, keychains).

Product: ${listing.title}
${listing.price ? `Price: ${listing.price}` : ''}
${listing.description ? `Description: ${listing.description.substring(0, 600)}` : ''}
${angle.id === 'review' && review ? `Customer review: "${review.text}"` : ''}

Angle for this script: ${angle.text}
Tone: ${tone.text}.

Rules:
- 3-4 sentences, 35-50 words total, written to be spoken aloud.
- Mention that it is handmade, but vary how you say it.
- Include at least one concrete detail about this specific product.
- End with this call to action, or a very close natural variation: "${cta}"
- Do NOT open with an exclamation or filler interjection. Start with a real sentence.
- Never use any of these words or phrases: ${BANNED_PHRASES.map(p => `"${p}"`).join(', ')}.
- Do not pretend to be a customer or say "I found". Speak as the shop, or as a neutral narrator.
- Do not start the way any of these recent scripts started:
${recentOpenings.length ? recentOpenings.map(o => `  - "${o}..."`).join('\n') : '  (none yet)'}
- No emojis, hashtags, stage directions, or quotation marks around the script.

Return ONLY the script text.`;

  let script = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const message = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 250,
      temperature: 1,
      messages: [{ role: 'user', content: prompt }],
    });
    script = textFromMessage(message).replace(/^["']|["']$/g, '').trim();
    const banned = findBanned(script);
    if (banned.length === 0) break;
    console.warn(`   ⚠️  Script used banned phrase(s) [${banned.join(', ')}], regenerating (${attempt}/3)`);
    if (attempt === 3) {
      // Last resort: strip a leading interjection like "Oh my gosh," rather than fail the post.
      script = script.replace(/^(oh my (gosh|god|goodness)|omg|oh wow|okay so|ok so)[,!.\s]*/i, '');
      script = script.charAt(0).toUpperCase() + script.slice(1);
    }
  }

  pushRecent('voiceover_history', { angle: angle.id, tone: tone.id, cta, script, at: new Date().toISOString() }, 20);
  console.log(`✅ Script: "${script.substring(0, 100)}..."`);
  return script;
}

async function generateVoiceover(script) {
  console.log('🎙️  Generating voiceover with ElevenLabs...');

  if (!ELEVENLABS_API_KEY) {
    throw new Error('Missing ELEVENLABS_API_KEY env var');
  }

  // Small, tone-matched variation in delivery so every clip doesn't have the
  // exact same cadence. Stays in a safe range for the voice.
  const style = lastTone ? lastTone.style : 0.3;
  const stability = 0.4 + Math.random() * 0.2; // 0.40-0.60

  let response;
  try {
    response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
      {
        text: script,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability,
          similarity_boost: 0.75,
          style,
          use_speaker_boost: true,
        },
      },
      {
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        responseType: 'arraybuffer',
        timeout: 30000,
      }
    );
  } catch (err) {
    // With responseType: 'arraybuffer', axios hands back the error body as
    // raw bytes too -- decode it so the real reason (invalid voice_id,
    // quota_exceeded, etc.) shows up in the logs.
    if (err.response && err.response.data) {
      let detail;
      try {
        detail = Buffer.from(err.response.data).toString('utf8');
        const parsed = JSON.parse(detail);
        detail = parsed?.detail?.message || parsed?.detail?.status || detail;
      } catch (parseErr) {
        // detail stays as the raw decoded text if it wasn't JSON
      }
      throw new Error(`ElevenLabs ${err.response.status}: ${detail}`);
    }
    throw err;
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const audioPath = path.join(OUTPUT_DIR, 'voiceover.mp3');
  fs.writeFileSync(audioPath, Buffer.from(response.data));
  console.log('✅ Voiceover generated');
  return audioPath;
}

module.exports = { generateVoiceoverScript, generateVoiceover, BANNED_PHRASES, findBanned };
