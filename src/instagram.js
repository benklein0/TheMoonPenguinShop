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
async function createMediaContainer({ mediaType, videoUrl, caption }) {
  const params = {
    media_type: mediaType,
    video_url: videoUrl,
    access_token: ACCESS_TOKEN,
  };
  if (mediaType === 'REELS') {
    params.caption = caption;
    params.share_to_feed = true;
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

async function uploadReel(videoPath, caption) {
  // 1. Upload to Cloudinary to get a public URL (shared by the Reel and,
  //    if enabled, the Story -- no need to upload the same file twice)
  const { publicUrl, publicId } = await uploadToCloudinary(videoPath);

  try {
    // 2. Create + publish the feed Reel
    console.log('📤 Creating Instagram media container...');
    const containerId = await createMediaContainer({ mediaType: 'REELS', videoUrl: publicUrl, caption });
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
