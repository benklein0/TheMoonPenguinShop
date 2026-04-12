// src/index.js
require('dotenv').config();
const cron = require('node-cron');
const { getNextListing, markAsPosted } = require('./rss');
const { generateCaption } = require('./caption');
const { createReel, cleanup } = require('./video');
const { uploadReel } = require('./instagram');
const { createPin } = require('./pinterest');

const REQUIRED_ENV = ['IG_ACCESS_TOKEN', 'IG_USER_ID', 'ANTHROPIC_API_KEY', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

// Weekday: 6am, 8am, 6pm, 8pm EST (Mon-Fri)
// Weekend: 9am, 12pm, 3pm, 5pm EST (Sat-Sun)
// All times in UTC (EST = UTC-4 during daylight saving)
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

  try {
    listing = await getNextListing();
    if (!listing) {
      console.log('💤 Nothing to post. Skipping.');
      return;
    }

    if (!listing.imageUrl) {
      console.warn(`⚠️  No image found for: ${listing.title} — skipping`);
      markAsPosted(listing.id); // skip it so we don't retry forever
      return;
    }

    const caption = await generateCaption(listing);
    console.log('\n📝 Caption preview:\n', caption.substring(0, 150) + '...\n');

    videoPath = await createReel(listing);
    await uploadReel(videoPath, caption);

    // Post to Pinterest if configured
    if (process.env.PINTEREST_ACCESS_TOKEN && process.env.PINTEREST_BOARD_ID) {
      try {
        await createPin(listing, caption);
      } catch (pinErr) {
        console.warn('⚠️  Pinterest post failed (non-fatal):', pinErr.message);
      }
    }

    // Mark as posted only after successful publish
    markAsPosted(listing.id);
    console.log(`\n🎉 Successfully posted: ${listing.title}`);

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
