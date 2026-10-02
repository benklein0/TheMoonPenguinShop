// src/instagram.js
// Uploads video to Cloudinary for public URL, then posts as Reel (and,
// optionally, a Story) via Instagram Graph API

const axios = require('axios');
const fs = require('fs');
const { readState, writeState } = require('./state');
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

// ---- Trending audio -------------------------------------------------------
// The Audio API has returned an empty list for every call so far without an
// error, so we don't know which piece is wrong (endpoint form, token type,
// account id, missing permission). Instead of guessing, try every plausible
// request shape and remember the first one that actually returns tracks.
const IG_AUDIO_ID = FB_IG_USER_ID || IG_USER_ID;
const AUDIO_SOURCES = [
  { name: 'fb-root',      host: FB_BASE_URL, token: () => FB_ACCESS_TOKEN, path: () => '/ig_audio',            params: () => ({ user_id: IG_AUDIO_ID }) },
  { name: 'fb-user-edge', host: FB_BASE_URL, token: () => FB_ACCESS_TOKEN, path: () => `/${IG_AUDIO_ID}/ig_audio`, params: () => ({}) },
  { name: 'ig-root',      host: BASE_URL,    token: () => ACCESS_TOKEN,    path: () => '/ig_audio',            params: () => ({ user_id: IG_USER_ID }) },
  { name: 'ig-user-edge', host: BASE_URL,    token: () => ACCESS_TOKEN,    path: () => `/${IG_USER_ID}/ig_audio`, params: () => ({}) },
];
const SEARCHES = ['cozy acoustic', 'lofi', 'whimsical', 'indie folk', 'soft piano', 'jazz cafe', 'chill pop', 'autumn', 'happy', 'love'];

async function fetchAudio(src, { search_query, audio_type = 'music' } = {}) {
  const token = src.token();
  if (!token) throw new Error('token not set');
  const res = await axios.get(`${src.host}${src.path()}`, {
    params: { ...src.params(), ...(audio_type ? { audio_type } : {}), ...(search_query ? { search_query } : {}), access_token: token },
    timeout: 15000,
  });
  return { raw: res.data, tracks: (res.data?.data || []).filter(t => t.audio_id || t.id) };
}

// Returns { id, title } or null. Never throws.
async function getTrendingAudio() {
  const remembered = readState('audio_source', null);
  const order = [...AUDIO_SOURCES].sort((a, b) => (b.name === remembered) - (a.name === remembered));
  const queries = [undefined, ...SEARCHES.sort(() => Math.random() - 0.5).slice(0, 3)];
  for (const src of order) {
    if (!src.token()) continue;
    for (const q of queries) {
      try {
        const { tracks } = await fetchAudio(src, { search_query: q });
        if (!tracks.length) continue;
        if (remembered !== src.name) writeState('audio_source', src.name);
        const recent = readState('recent_audio', []);
        const pool = tracks.slice(0, Math.min(15, tracks.length));
        const fresh = pool.filter(t => !recent.includes(t.audio_id || t.id));
        const pick = (fresh.length ? fresh : pool)[Math.floor(Math.random() * (fresh.length || pool.length))];
        const id = pick.audio_id || pick.id;
        writeState('recent_audio', [...recent, id].slice(-10));
        const title = [pick.title, pick.display_artist].filter(Boolean).join(' - ') || id;
        console.log(`🎧 Audio selected via ${src.name}${q ? ` (search "${q}")` : ' (trending)'}: ${title} (of ${tracks.length})`);
        return { id, title, api: src.host === FB_BASE_URL ? 'facebook' : 'instagram' };
      } catch (err) {
        // A path error on one shape just means try the next shape.
        if (!q) { console.warn(`   audio ${src.name}: ${errMsg(err)}`); break; }
      }
    }
  }
  console.warn('⚠️  No audio tracks from any Audio API request shape (see 🩺 diagnosis in startup logs)');
  return null;
}

// One-time startup report: shows exactly what Meta says about the token,
// the linked accounts, and each audio request shape, so the next fix is
// based on facts instead of guesses. Read-only; never posts.
async function diagnoseAudio() {
  const cut = o => { const t = JSON.stringify(o); return t.length > 500 ? t.slice(0, 500) + '…' : t; };
  const get = async (url, params) => {
    try { return (await axios.get(url, { params, timeout: 15000 })).data; }
    catch (err) { return { error: err.response?.data?.error || err.message }; }
  };
  console.log('🩺 ---- Audio API diagnosis ----');
  console.log(`🩺 env: FB_PAGE_ACCESS_TOKEN=${FB_ACCESS_TOKEN ? 'set' : 'MISSING'} IG_BUSINESS_ACCOUNT_ID=${FB_IG_USER_ID || 'MISSING'} IG_USER_ID=${IG_USER_ID || 'MISSING'} FB_PAGE_ID=${process.env.FB_PAGE_ID || 'MISSING'}`);
  if (FB_ACCESS_TOKEN) {
    const dbg = await get(`${FB_BASE_URL}/debug_token`, { input_token: FB_ACCESS_TOKEN, access_token: FB_ACCESS_TOKEN });
    const d = dbg.data || dbg;
    console.log(`🩺 FB token: valid=${d.is_valid} type=${d.type} app=${d.app_id} expires=${d.expires_at} scopes=${(d.scopes || []).join(',')} ${d.error ? cut(d.error) : ''}`);
    console.log(`🩺 FB /me: ${cut(await get(`${FB_BASE_URL}/me`, { fields: 'id,name', access_token: FB_ACCESS_TOKEN }))}`);
    if (process.env.FB_PAGE_ID) {
      console.log(`🩺 Page→IG link: ${cut(await get(`${FB_BASE_URL}/${process.env.FB_PAGE_ID}`, { fields: 'instagram_business_account{id,username}', access_token: FB_ACCESS_TOKEN }))}`);
    }
  }
  if (ACCESS_TOKEN) {
    console.log(`🩺 IG /me: ${cut(await get(`${BASE_URL}/me`, { fields: 'user_id,username,account_type', access_token: ACCESS_TOKEN }))}`);
  }
  for (const src of AUDIO_SOURCES) {
    if (!src.token()) { console.log(`🩺 ${src.name}: skipped (no token)`); continue; }
    for (const opts of [{}, { audio_type: null }, { search_query: 'love' }]) {
      const label = opts.search_query ? 'search "love"' : opts.audio_type === null ? 'no audio_type' : 'trending';
      try {
        const { raw, tracks } = await fetchAudio(src, opts);
        console.log(`🩺 ${src.name} ${label}: ${tracks.length} tracks ${cut(raw)}`);
      } catch (err) {
        console.log(`🩺 ${src.name} ${label}: ERROR ${cut(err.response?.data?.error || err.message)}`);
      }
    }
  }
  console.log('🩺 ---- end diagnosis ----');
}

const errMsg = err => err.response?.data?.error?.message || err.message;

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

// Two ways to talk to the Instagram API:
//  - IG: Instagram Login (graph.instagram.com + IG_ACCESS_TOKEN) -- does all
//        normal posting.
//  - FB: Facebook Login (graph.facebook.com + Page token) -- the documented
//        home of the Audio API, used as a fallback when attaching audio.
const IG_API = { name: 'instagram', base: BASE_URL, token: ACCESS_TOKEN, userId: IG_USER_ID };
const FB_API = { name: 'facebook', base: FB_BASE_URL, token: FB_ACCESS_TOKEN, userId: FB_IG_USER_ID };

// Creates a media container for either a feed Reel or a Story.
// (Stories only take video_url/media_type -- no caption, no share_to_feed.)
// audio = { id, audioVolume, videoVolume } attaches an Instagram audio track;
// volumes are integers 0-100 per the Audio API docs.
async function createMediaContainer({ api = IG_API, mediaType, videoUrl, caption, audio }) {
  const params = {
    media_type: mediaType,
    video_url: videoUrl,
    access_token: api.token,
  };
  if (mediaType === 'REELS') {
    params.caption = caption;
    params.share_to_feed = true;
  }
  if (audio) {
    params.audio_configuration = JSON.stringify({
      audio_id: audio.id,
      audio_volume: audio.audioVolume,
      video_volume: audio.videoVolume,
    });
  }
  const res = await axios.post(`${api.base}/${api.userId}/media`, null, { params });
  return res.data.id;
}

async function waitForContainer(containerId, api = IG_API) {
  let status = 'IN_PROGRESS';
  let statusDetail = null;
  let attempts = 0;
  while (status !== 'FINISHED' && status !== 'ERROR' && attempts < 24) {
    await sleep(10000);
    const statusRes = await axios.get(`${api.base}/${containerId}`, {
      // 'status' carries an error subcode when status_code is ERROR.
      params: { fields: 'status_code,status', access_token: api.token }
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

async function publishContainer(containerId, api = IG_API) {
  const publishRes = await axios.post(`${api.base}/${api.userId}/media_publish`, null, {
    params: { creation_id: containerId, access_token: api.token }
  });
  return publishRes.data.id;
}

// Create + process + publish a Reel. If trending audio is requested, try
// attaching it via Instagram Login first, then via Facebook Login, and
// finally fall back to posting with the video's own music -- a post always
// goes out.
async function publishReel(publicUrl, caption, audio) {
  const attempts = [];
  if (audio) {
    // Attach via the same API that returned the track first, then the other.
    const apis = audio.api === 'instagram' ? [IG_API, FB_API] : [FB_API, IG_API];
    for (const api of apis) if (api.token && api.userId) attempts.push({ api, audio });
  }
  attempts.push({ api: IG_API, audio: null });

  let lastErr;
  for (const { api, audio: a } of attempts) {
    try {
      console.log(`📤 Creating Reel container via ${api.name}${a ? ` with trending audio` : ''}...`);
      const containerId = await createMediaContainer({ api, mediaType: 'REELS', videoUrl: publicUrl, caption, audio: a });
      console.log(`📦 Container created: ${containerId}`);
      console.log('⏳ Waiting for Instagram to process video...');
      await waitForContainer(containerId, api);
      console.log('🚀 Publishing Reel...');
      const mediaId = await publishContainer(containerId, api);
      console.log(`✅ Reel published${a ? ' with trending audio' : ''}! Media ID: ${mediaId}`);
      return mediaId;
    } catch (err) {
      lastErr = err;
      console.warn(`⚠️  Reel attempt via ${api.name}${a ? ' with audio' : ''} failed: ${errMsg(err)}`);
    }
  }
  throw lastErr;
}

// audioMode: 'replace' (trending song only, for standard reels),
//            'under'   (trending song quietly under the voiceover), or
//            'none'.
async function uploadReel(videoPath, caption, { audioMode = 'none' } = {}) {
  // 1. Upload to Cloudinary to get a public URL (shared by Reel + Story)
  const { publicUrl, publicId } = await uploadToCloudinary(videoPath);

  let audio = null;
  if (audioMode !== 'none' && process.env.USE_TRENDING_AUDIO !== 'false') {
    const track = await getTrendingAudio();
    if (track) {
      audio = audioMode === 'under'
        ? { id: track.id, api: track.api, audioVolume: 12, videoVolume: 100 }
        : { id: track.id, api: track.api, audioVolume: 100, videoVolume: 0 };
    }
  }

  try {
    // 2. Create + publish the feed Reel
    const mediaId = await publishReel(publicUrl, caption, audio);

    // 3. Also share the same clip to Stories. (The Graph API can't add link
    // stickers to Stories, so this is for reach, not click-through.)
    // Set POST_TO_STORY=false in the environment to disable.
    if (process.env.POST_TO_STORY !== 'false') {
      try {
        console.log('📖 Sharing to Instagram Story...');
        const storyContainerId = await createMediaContainer({ mediaType: 'STORIES', videoUrl: publicUrl });
        await waitForContainer(storyContainerId);
        const storyMediaId = await publishContainer(storyContainerId);
        console.log(`✅ Story published! Media ID: ${storyMediaId}`);
      } catch (storyErr) {
        console.warn('⚠️  Story post failed (non-fatal):', errMsg(storyErr));
      }
    }

    return mediaId;

  } finally {
    // Always clean up Cloudinary
    await deleteFromCloudinary(publicId);
  }
}

// Startup diagnostic: logs whether the Audio API is reachable, without posting.
async function checkTrendingAudio() {
  await diagnoseAudio();
  const track = await getTrendingAudio();
  console.log(track ? '🩺 Trending audio: OK' : '🩺 Trending audio: NOT available (see warning above)');
}

module.exports = { uploadReel, checkTrendingAudio };
