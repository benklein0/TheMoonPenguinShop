// src/voiceover.js
// Generates voiceover audio using ElevenLabs API

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'gsm4lUH9bnZ3pjR1Pw7w'; // Claire
const OUTPUT_DIR = './tmp';

async function generateVoiceoverScript(listing) {
  console.log('📝 Generating voiceover script...');

  const prompt = `You are writing a short, enthusiastic voiceover script for a 15-second Instagram Reel ad for TheMoonPenguinShop, a handmade accessories shop.

Product: ${listing.title}
${listing.price ? `Price: ${listing.price}` : ''}
${listing.description ? `Description: ${listing.description}` : ''}

Write a warm, feminine, enthusiastic voiceover script that:
- Is exactly 3-4 sentences long (fits in ~15 seconds when spoken)
- Sounds natural and conversational, not like a commercial
- Emphasizes the handmade, one-of-a-kind nature of the piece
- Mentions a specific detail about the product (color, material, function)
- Ends with a gentle call to action like "find it at the link in bio"
- Does NOT sound like a fake review — sounds like an excited friend telling you about something beautiful they found
- No emojis, no hashtags, just natural spoken words

Return ONLY the script text, nothing else.`;

  const message = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }]
  });

  const script = message.content[0].text.trim();
  console.log(`✅ Script: "${script.substring(0, 80)}..."`);
  return script;
}

async function generateVoiceover(script) {
  console.log('🎙️  Generating voiceover with ElevenLabs...');

  const response = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
    {
      text: script,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.3,
        use_speaker_boost: true
      }
    },
    {
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      responseType: 'arraybuffer',
      timeout: 30000
    }
  );

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const audioPath = path.join(OUTPUT_DIR, 'voiceover.mp3');
  fs.writeFileSync(audioPath, Buffer.from(response.data));
  console.log('✅ Voiceover generated');
  return audioPath;
}

module.exports = { generateVoiceoverScript, generateVoiceover };
