// src/test.js
require('dotenv').config();
const { getNextListing, markAsPosted } = require('./rss');
const { generateCaption } = require('./caption');
const { generateVoiceoverScript, generateVoiceover } = require('./voiceover');
const { createReel, createVoiceoverReel, cleanup } = require('./video');
const { uploadReel } = require('./instagram');
const { createPin } = require('./pinterest');

async function test() {
  console.log('🧪 MoonPenguinPoster — Manual Test Run\n');

  const missing = ['IG_ACCESS_TOKEN', 'IG_USER_ID', 'ANTHROPIC_API_KEY', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'].filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error('❌ Missing env vars:', missing.join(', '));
    process.exit(1);
  }

  // Set REEL_TYPE=voiceover to test voiceover mode, otherwise defaults to standard
  const reelType = process.env.REEL_TYPE || 'standard';
  console.log(`🎬 Testing reel type: ${reelType}\n`);

  let videoPath = null;

  try {
    console.log('Step 1: Fetching next listing from RSS queue...');
    const listing = await getNextListing();

    if (!listing) {
      console.log('⚠️  No unposted listings found. Delete data/listings.json to reset.');
      return;
    }

    console.log('\n📦 Listing found:');
    console.log(`   Title: ${listing.title}`);
    console.log(`   Price: ${listing.price}`);
    console.log(`   Image: ${listing.imageUrl}`);
    console.log(`   URL:   ${listing.listingUrl}\n`);

    if (!listing.imageUrl) {
      console.error('❌ No image URL found. Cannot create Reel.');
      return;
    }

    console.log('Step 2: Generating caption...');
    const caption = await generateCaption(listing);
    console.log('\n📝 Full caption:\n');
    console.log(caption);
    console.log('\n');

    console.log('Step 3: Creating Reel video...');
    if (reelType === 'voiceover') {
      console.log('   Generating voiceover script...');
      const script = await generateVoiceoverScript(listing);
      console.log(`   Script: "${script.substring(0, 100)}..."`);
      console.log('   Generating audio with ElevenLabs...');
      const voiceoverPath = await generateVoiceover(script);
      videoPath = await createVoiceoverReel(listing, voiceoverPath);
    } else {
      videoPath = await createReel(listing);
    }
    console.log(`   Video: ${videoPath}\n`);

    const skipPost = process.env.SKIP_POST === 'true';
    if (!skipPost) {
      console.log('Step 4: Uploading to Instagram...');
      await uploadReel(videoPath, caption);

      if (process.env.PINTEREST_ACCESS_TOKEN && process.env.PINTEREST_BOARD_ID) {
        console.log('Step 5: Posting to Pinterest...');
        await createPin(listing, caption);
      }

      markAsPosted(listing.id);
      console.log('\n✅ Test complete — posted successfully!');
    } else {
      console.log('Step 4: Skipped (SKIP_POST=true)');
      console.log(`\n✅ Test complete — video saved at ${videoPath}`);
    }

  } catch (err) {
    console.error('\n❌ Test failed:', err.message);
    if (err.response) {
      console.error('API response:', JSON.stringify(err.response.data, null, 2));
    }
    process.exitCode = 1;
  } finally {
    if (videoPath && process.env.SKIP_POST !== 'true') {
      cleanup(videoPath);
    }
  }
}

test();
