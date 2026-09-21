// src/instagram.js
// Uploads video to Cloudinary for public URL, then posts as Reel (and,
// optionally, a Story) via Instagram Graph API

const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');

const IG_USER_ID = process.env.IG_USER_ID;
const ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;
const API_VERSION = 'v25.0';
const BASE_URL = `https://graph.instagram.com/${API_VERSION}`;

// Trending audio needs the *Facebook Login* side of the Instagram Graph API
// (graph.facebook.com + a Page access token) -- the Instagram-Login side
// above (graph.instagram.com + IG_ACCESS_TOKEN) that does all the actual
// posting doesn't expose the audio catalog. These are optional: if unset,
// getTrendingAudioId() just returns null and posting proceeds with the
// video's own baked-in music, same as before this feature existed.
const FB_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const FB_IG_USER_ID = process.env.IG_BUSINESS_ACCOUNT_ID;
const FB_BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

// Fetch a trending/popular audio track from Instagram's own audio catalog.
// Returns an audio_id to attach to a Reel container, or null if unavailable
// (missing Facebook Login credentials, API error, or empty catalog) so the
// caller can fall back to the video's existing local background music.
async function getTrendingAudioId() {
  if (!FB_ACCESS_TOKEN || !FB_IG_USER_ID) return null;
  try {
    const res = await axios.get(`${FB_BASE_URL}/${FB_IG_USER_ID}/ig_audio`, {
      params: { audio_type: 'music', access_token: FB_ACCESS_TOKEN }
    });
    const tracks = res.data.data || [];
    if (tracks.length === 0) {
      console.warn('⚠️  Trending audio catalog returned no tracks');
      return null;
    }
    // Pick randomly among the top results for variety across posts,
    // rather than hammering the same track every time.
    const pool = tracks.slice(0, Math.min(10, tracks.length));
    const pick = pool[Math.floor(Math.random() * pool.length)];
    console.log(`🎧 Trending audio selected: ${pick.audio_name || pick.id}`);
    return pick.id;
  } catch (err) {
    console.warn('⚠️  Could not fetch trending audio (non-fatal):', err.response?.data?.error?.message || err.message);
    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Step 1: Upload video to Cloudinary and get a public URL
async function uploadToCloudinary(videoPath) {
  console.log('☁️  Uploading video to Cloudinary...');

  const crypto = require('crypto');
  const timestamp = Math.floor(Date.now() / 1000);

  // Generate signature
  const sigStr = `timestamp=${timestamp}${CLOUDINARY_API_SECRET}`;
  const signature = crypto.createHash('sha1').update(sigStr).digest('hex');

  const form = new FormData();
  form.append('file', fs.createReadStream(videoPath));
  form.append('api_key', CLOUDINARY_API_KEY);
  form.append('timestamp', timestamp);
  form.append('signature', signature);

  const res = await axios.post(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/video/upload`,
    form,
    { headers: form.getHeaders(), maxContentLength: Infinity, maxBodyLength: Infinity, timeout: 60000 }
  );

  const publicUrl = res.data.secure_url;
  const publicId = res.data.public_id;
  console.log(`✅ Uploaded to Cloudinary: ${publicUrl}`);
  return { publicUrl, publicId };
}

// Step 2: Delete video from Cloudinary after posting (cleanup)
async function deleteFromCloudinary(publicId) {
  try {
    const crypto = require('crypto');
    const timestamp = Math.floor(Date.now() / 1000);
    const sigStr = `public_id=${publicId}&timestamp=${timestamp}${CLOUDINARY_API_SECRET}`;
    const signature = crypto.createHash('sha1').update(sigStr).digest('hex');

    await axios.post(
      `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/video/destroy`,
      { public_id: publicId, api_key: CLOUDINARY_API_KEY, timestamp, signature }
    );
    console.log('🗑️  Cleaned up Cloudinary upload');
  } catch (e) {
    console.warn('Cloudinary cleanup warning:', e.message);
  }
}

// Creates a media container for either a feed Reel or a Story.
// (Stories only take video_url/media_type -- no caption, no share_to_feed.)
// audioId, when provided, attaches a trending audio track to the Reel and
// mutes the video's own baked-in track so the trending song carries it
// cleanly instead of layering over the local background music.
async function createMediaContainer({ mediaType, videoUrl, caption, audioId }) {
  const params = {
    media_type: mediaType,
    video_url: videoUrl,
    access_token: ACCESS_TOKEN,
  };
  if (mediaType === 'REELS') {
    params.caption = caption;
    params.share_to_feed = true;
  }
  if (audioId) {
    params.audio_configuration = JSON.stringify({
      audio_id: audioId,
      audio_volume: 1.0,
      video_volume: 0.0,
    });
  }
  const res = await axios.post(`${BASE_URL}/${IG_USER_ID}/media`, null, { params });
  return res.data.id;
}

async function waitForContainer(containerId) {
  let status = 'IN_PROGRESS';
  let statusDetail = null;
  let attempts = 0;
  while (status !== 'FINISHED' && status !== 'ERROR' && attempts < 24) {
    await sleep(10000);
    const statusRes = await axios.get(`${BASE_URL}/${containerId}`, {
      // 'status' carries an error subcode when status_code is ERROR --
      // without it an ERROR gives no clue why, which is exactly what
      // happened when the mono-audio bug first showed up here.
      params: { fields: 'status_code,status', access_token: ACCESS_TOKEN }
    });
    status = statusRes.data.status_code;
    statusDetail = statusRes.data.status;
    console.log(`   Status: ${status}${statusDetail ? ` (${statusDetail})` : ''} (${attempts + 1}/24)`);
    attempts++;
  }
  if (status !== 'FINISHED') {
    throw new Error(`Video processing failed with status: ${status}${statusDetail ? ` -- ${statusDetail}` : ''}`);
  }
}

async function publishContainer(containerId) {
  const publishRes = await axios.post(`${BASE_URL}/${IG_USER_ID}/media_publish`, null, {
    params: { creation_id: containerId, access_token: ACCESS_TOKEN }
  });
  return publishRes.data.id;
}

async function uploadReel(videoPath, caption, { useTrendingAudio = false } = {}) {
  // 1. Upload to Cloudinary to get a public URL (shared by the Reel and,
  //    if enabled, the Story -- no need to upload the same file twice)
  const { publicUrl, publicId } = await uploadToCloudinary(videoPath);

  // Trending audio is opt-in per call (standard reels only -- voiceover
  // reels need their narration audible, not swapped for a song) and quietly
  // does nothing if Facebook Login credentials aren't set up or the catalog
  // call fails, so this never blocks a post from going out.
  const audioId = useTrendingAudio ? await getTrendingAudioId() : null;

  try {
    // 2. Create + publish the feed Reel
    console.log('📤 Creating Instagram media container...');
    const containerId = await createMediaContainer({ mediaType: 'REELS', videoUrl: publicUrl, caption, audioId });
    console.log(`📦 Container created: ${containerId}`);

    console.log('⏳ Waiting for Instagram to process video...');
    await waitForContainer(containerId);

    console.log('🚀 Publishing Reel...');
    const mediaId = await publishContainer(containerId);
    console.log(`✅ Reel published! Media ID: ${mediaId}`);

    // 3. Also share the same clip to Stories. Note: Instagram's Graph API
    // does not support attaching a link sticker to a Story (confirmed
    // against Meta's own docs -- "Publishing stickers (i.e., link, poll,
    // location) is not supported"), so this is purely for extra reach /
    // keeping the account active in followers' Stories tray. It does NOT
    // replace the bio-link click-through -- that's still the caption + bio.
    // Set POST_TO_STORY=false in the environment to disable.
    if (process.env.POST_TO_STORY !== 'false') {
      try {
        console.log('📖 Sharing to Instagram Story...');
        const storyContainerId = await createMediaContainer({ mediaType: 'STORIES', videoUrl: publicUrl });
        await waitForContainer(storyContainerId);
        const storyMediaId = await publishContainer(storyContainerId);
        console.log(`✅ Story published! Media ID: ${storyMediaId}`);
      } catch (storyErr) {
        console.warn('⚠️  Story post failed (non-fatal):', storyErr.message);
      }
    }

    return mediaId;

  } finally {
    // Always clean up Cloudinary
    await deleteFromCloudinary(publicId);
  }
}

module.exports = { uploadReel };
