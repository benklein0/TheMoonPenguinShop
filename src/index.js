// src/index.js
require('dotenv').config();
const cron = require('node-cron');
const { getNextListing, markAsPosted } = require('./rss');
const { generateCaption } = require('./caption');
const { generateVoiceoverScript, generateVoiceover } = require('./voiceover');
const { createReel, createVoiceoverReel, cleanup } = require('./video');
const { uploadReel } = require('./instagram');
const { createPin } = require('./pinterest');
const fs = require('fs');

const REQUIRED_ENV = ['IG_ACCESS_TOKEN', 'IG_USER_ID', 'ANTHROPIC_API_KEY', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

// Track which reel type to use next (alternates each post)
const REEL_TYPE_FILE = './data/reel_type.json';

function getNextReelType() {
  try {
    if (!fs.existsSync('./data')) fs.mkdirSync('./data', { recursive: true });
    if (!fs.existsSync(REEL_TYPE_FILE)) return 'standard';
    const data = JSON.parse(fs.readFileSync(REEL_TYPE_FILE, 'utf8'));
    return data.next || 'standard';
  } catch { return 'standard'; }
}

function setNextReelType(current) {
  const next = current === 'standard' ? 'voiceover' : 'standard';
  fs.writeFileSync(REEL_TYPE_FILE, JSON.stringify({ next }));
}

// Weekday: 6am, 8am, 6pm, 8pm EST (Mon-Fri)
// Weekend: 9am, 12pm, 3pm, 5pm EST (Sat-Sun)
const POST_TIMES = [
  { cron: '0 10 * * 1-5', label: '6:00 AM EST (Weekday)' },
  { cron: '0 12 * * 1-5', label: '8:00 AM EST (Weekday)' },
  { cron: '0 22 * * 1-5', label: '6:00 PM EST (Weekday)' },
  { cron: '0 0 * * 2-6',  label: '8:00 PM EST (Weekday)' },
  { cron: '0 13 * * 0,6', label: '9:00 AM EST (Weekend)' },
  { cron: '0 16 * * 0,6', label: '12:00 PM EST (Weekend)' },
  { cron: '0 19 * * 0,6', label: '3:00 PM EST (Weekend)' },
  { cron: '0 21 * * 0,6', label: '5:00 PM EST (Weekend)' },
];

async function runPipeline() {
  console.log('\n🐧 MoonPenguinPoster — Starting pipeline run');
  console.log(`⏰ ${new Date().toISOString()}`);

  let listing = null;
  let videoPath = null;
  const reelType = getNextReelType();
  console.log(`🎬 Reel type: ${reelType}`);

  try {
    listing = await getNextListing();
    if (!listing) {
      console.log('💤 Nothing to post. Skipping.');
      return;
    }

    if (!listing.imageUrl) {
      console.warn(`⚠️  No image found for: ${listing.title} — skipping`);
      markAsPosted(listing.id);
      return;
    }

    const caption = await generateCaption(listing);
    console.log('\n📝 Caption preview:\n', caption.substring(0, 150) + '...\n');

    if (reelType === 'voiceover' && process.env.ELEVENLABS_API_KEY) {
      // Voiceover ad reel
      const script = await generateVoiceoverScript(listing);
      const voiceoverPath = await generateVoiceover(script);
      videoPath = await createVoiceoverReel(listing, voiceoverPath);
    } else {
      // Standard text overlay reel
      videoPath = await createReel(listing);
    }

    await uploadReel(videoPath, caption);

    // Post to Pinterest if configured
    if (process.env.PINTEREST_ACCESS_TOKEN && process.env.PINTEREST_BOARD_ID) {
      try {
        await createPin(listing, caption);
      } catch (pinErr) {
        console.warn('⚠️  Pinterest post failed (non-fatal):', pinErr.message);
      }
    }

    markAsPosted(listing.id);
    setNextReelType(reelType);
    console.log(`\n🎉 Successfully posted: ${listing.title} (${reelType} reel)`);

  } catch (err) {
    console.error('\n❌ Pipeline error:', err.message);
    if (err.response) {
      console.error('API response:', JSON.stringify(err.response.data, null, 2));
    }
  } finally {
    if (videoPath) cleanup(videoPath);
  }
}

POST_TIMES.forEach(({ cron: cronTime, label }) => {
  cron.schedule(cronTime, () => {
    console.log(`\n⏰ Scheduled trigger: ${label}`);
    runPipeline();
  }, { timezone: 'UTC' });
  console.log(`📅 Scheduled: ${label} (${cronTime})`);
});

console.log('\n🐧 MoonPenguinPoster is running.');
console.log('   Weekdays: 6am, 8am, 6pm, 8pm EST');
console.log('   Weekends: 9am, 12pm, 3pm, 5pm EST\n');

if (process.env.RUN_NOW === 'true') {
  console.log('🚀 RUN_NOW=true detected, running pipeline immediately...');
  runPipeline();
}
