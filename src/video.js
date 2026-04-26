// src/video.js
const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = './tmp';
const MUSIC_DIR = './';
const VIDEO_WIDTH = 1080;
const VIDEO_HEIGHT = 1920;
const MUSIC_VOLUME = 0.3;
const VOICEOVER_MUSIC_VOLUME = 0.03; // much quieter when there's a voiceover

function ensureDirs() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function getRandomTrack() {
  const tracks = fs.readdirSync(MUSIC_DIR).filter(f => f.match(/^\d+\.mp3$/));
  if (tracks.length === 0) throw new Error('No mp3 tracks found in root directory');
  const pick = tracks[Math.floor(Math.random() * tracks.length)];
  console.log(`🎵 Selected track: ${pick}`);
  return path.join(MUSIC_DIR, pick);
}

async function downloadImage(url, destPath) {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  fs.writeFileSync(destPath, response.data);
}

async function ensureFont() {
  const fontPath = path.join(OUTPUT_DIR, 'font.ttf');
  if (!fs.existsSync(fontPath)) {
    console.log('📥 Downloading font...');
    const res = await axios.get(
      'https://fonts.gstatic.com/s/playfairdisplay/v37/nuFvD-vYSZviVYUb_rj3ij__anPXJzDwcbmjWBN2PKdFvUDQ.ttf',
      { responseType: 'arraybuffer', timeout: 15000 }
    );
    fs.writeFileSync(fontPath, Buffer.from(res.data));
    console.log('✅ Font downloaded');
  }
  return fontPath;
}

function wrapTitle(title, maxChars = 26) {
  const words = title.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length <= maxChars) {
      current = (current + ' ' + word).trim();
    } else {
      if (current) lines.push(current);
      current = word;
      if (lines.length >= 2) break;
    }
  }
  if (current && lines.length < 3) lines.push(current);
  return lines.slice(0, 3);
}

function ffmpegEscape(str) {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

async function composeBgFrame(imagePath, withTextOverlay = true, listing = null) {
  const framePath = path.join(OUTPUT_DIR, 'frame.png');
  const imageHeight = withTextOverlay ? 1350 : VIDEO_HEIGHT;
  const resizedPath = path.join(OUTPUT_DIR, 'resized.png');

  await sharp(imagePath)
    .resize(VIDEO_WIDTH, imageHeight, { fit: 'cover', position: 'centre' })
    .toFile(resizedPath);

  const svg = `
<svg width="${VIDEO_WIDTH}" height="${VIDEO_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="topGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" style="stop-color:black;stop-opacity:0.55"/>
      <stop offset="100%" style="stop-color:black;stop-opacity:0"/>
    </linearGradient>
    <linearGradient id="bottomGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" style="stop-color:black;stop-opacity:0"/>
      <stop offset="100%" style="stop-color:black;stop-opacity:${withTextOverlay ? '0.88' : '0.5'}"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${VIDEO_WIDTH}" height="200" fill="url(#topGrad)"/>
  <rect x="0" y="${VIDEO_HEIGHT - 650}" width="${VIDEO_WIDTH}" height="650" fill="url(#bottomGrad)"/>
</svg>`;

  await sharp({
    create: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT, channels: 4, background: { r: 245, g: 240, b: 235, alpha: 1 } }
  })
    .composite([
      { input: resizedPath, top: 0, left: 0 },
      { input: Buffer.from(svg), top: 0, left: 0 }
    ])
    .png()
    .toFile(framePath);

  return framePath;
}

// Standard text overlay reel (existing style)
async function createReel(listing) {
  ensureDirs();
  console.log(`🎬 Composing Reel for: ${listing.title}`);

  const rawImagePath = path.join(OUTPUT_DIR, 'product_raw.jpg');
  await downloadImage(listing.imageUrl, rawImagePath);

  const framePath = await composeBgFrame(rawImagePath, true, listing);
  const fontPath = await ensureFont();
  const musicPath = getRandomTrack();
  const outputPath = path.join(OUTPUT_DIR, `reel_${Date.now()}.mp4`);

  const titleLines = wrapTitle(listing.title);
  const price = listing.price || '';
  const filters = [];
  const lineHeight = 75;
  const titleBaseY = VIDEO_HEIGHT - 380 - (titleLines.length - 1) * lineHeight;
  const font = ffmpegEscape(fontPath);

  filters.push(`drawtext=fontfile='${font}':text='@themoonpenguinshop':fontcolor=white:fontsize=46:x=(w-text_w)/2:y=95`);
  titleLines.forEach((line, i) => {
    filters.push(`drawtext=fontfile='${font}':text='${ffmpegEscape(line)}':fontcolor=white:fontsize=56:x=(w-text_w)/2:y=${titleBaseY + i * lineHeight}`);
  });
  if (price) {
    filters.push(`drawtext=fontfile='${font}':text='${ffmpegEscape(price)}':fontcolor=white:fontsize=44:x=(w-text_w)/2:y=${VIDEO_HEIGHT - 230}`);
  }
  filters.push(`drawtext=fontfile='${font}':text='Shop via link in bio':fontcolor=white:fontsize=36:x=(w-text_w)/2:y=${VIDEO_HEIGHT - 105}`);

  const filterString = filters.join(',');
  const duration = 10;

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(framePath).inputOptions([`-loop 1`, `-t ${duration}`])
      .input(musicPath).inputOptions([`-t ${duration}`])
      .videoFilters(filterString)
      .outputOptions(['-c:v libx264', '-tune stillimage', '-c:a aac', '-b:a 192k', `-af volume=${MUSIC_VOLUME}`, '-pix_fmt yuv420p', '-shortest', '-movflags +faststart'])
      .output(outputPath)
      .on('end', resolve)
      .on('error', (err) => { console.error('ffmpeg error:', err.message); reject(err); })
      .run();
  });

  console.log(`✅ Reel created: ${outputPath}`);
  return outputPath;
}

// Voiceover ad reel — product image + AI voiceover + subtle music
async function createVoiceoverReel(listing, voiceoverPath) {
  ensureDirs();
  console.log(`🎬 Composing voiceover ad for: ${listing.title}`);

  const rawImagePath = path.join(OUTPUT_DIR, 'product_raw.jpg');
  await downloadImage(listing.imageUrl, rawImagePath);

  const framePath = await composeBgFrame(rawImagePath, false);
  const fontPath = await ensureFont();
  const musicPath = getRandomTrack();
  const outputPath = path.join(OUTPUT_DIR, `reel_vo_${Date.now()}.mp4`);

  // Get voiceover duration to set video length
  const { execSync } = require('child_process');
  let duration = 15; // default
  try {
    const probe = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${voiceoverPath}"`).toString().trim();
    duration = Math.ceil(parseFloat(probe)) + 1; // add 1 second buffer
  } catch {}

  const font = ffmpegEscape(fontPath);
  const filters = [
    `drawtext=fontfile='${font}':text='@themoonpenguinshop':fontcolor=white:fontsize=46:x=(w-text_w)/2:y=95`,
    `drawtext=fontfile='${font}':text='Shop via link in bio':fontcolor=white:fontsize=36:x=(w-text_w)/2:y=${VIDEO_HEIGHT - 105}`
  ];

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(framePath).inputOptions([`-loop 1`, `-t ${duration}`])
      .input(musicPath).inputOptions([`-t ${duration}`])
      .input(voiceoverPath)
      .videoFilters(filters.join(','))
      .outputOptions([
        '-c:v libx264',
        '-tune stillimage',
        '-c:a aac',
        '-b:a 192k',
        // Mix music quietly + voiceover at full volume
        `-filter_complex [1:a]volume=${VOICEOVER_MUSIC_VOLUME}[music];[2:a]volume=1.0[vo];[music][vo]amix=inputs=2:duration=first[aout]`,
        '-map 0:v',
        '-map [aout]',
        '-pix_fmt yuv420p',
        '-shortest',
        '-movflags +faststart'
      ])
      .output(outputPath)
      .on('end', resolve)
      .on('error', (err) => { console.error('ffmpeg error:', err.message); reject(err); })
      .run();
  });

  console.log(`✅ Voiceover reel created: ${outputPath}`);
  return outputPath;
}

function cleanup(videoPath) {
  try {
    const files = [
      videoPath,
      path.join(OUTPUT_DIR, 'frame.png'),
      path.join(OUTPUT_DIR, 'resized.png'),
      path.join(OUTPUT_DIR, 'product_raw.jpg'),
      path.join(OUTPUT_DIR, 'voiceover.mp3')
    ];
    files.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
  } catch (e) {
    console.warn('Cleanup warning:', e.message);
  }
}

module.exports = { createReel, createVoiceoverReel, cleanup };
