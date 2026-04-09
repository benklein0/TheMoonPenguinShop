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
const VIDEO_DURATION = 10;
const MUSIC_VOLUME = 0.3;

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

// Download a font file for use with ffmpeg drawtext
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

// Wrap title into lines for ffmpeg drawtext
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

// Escape text for ffmpeg drawtext
function ffmpegEscape(str) {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

async function composeBgFrame(imagePath) {
  const framePath = path.join(OUTPUT_DIR, 'frame.png');
  const imageHeight = 1350;
  const resizedPath = path.join(OUTPUT_DIR, 'resized.png');

  await sharp(imagePath)
    .resize(VIDEO_WIDTH, imageHeight, { fit: 'cover', position: 'centre' })
    .toFile(resizedPath);

  // Create base canvas with image + gradients (no text — text added by ffmpeg)
  const svg = `
<svg width="${VIDEO_WIDTH}" height="${VIDEO_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="topGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" style="stop-color:black;stop-opacity:0.55"/>
      <stop offset="100%" style="stop-color:black;stop-opacity:0"/>
    </linearGradient>
    <linearGradient id="bottomGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" style="stop-color:black;stop-opacity:0"/>
      <stop offset="100%" style="stop-color:black;stop-opacity:0.88"/>
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

async function createReel(listing) {
  ensureDirs();
  console.log(`🎬 Composing Reel for: ${listing.title}`);

  const rawImagePath = path.join(OUTPUT_DIR, 'product_raw.jpg');
  await downloadImage(listing.imageUrl, rawImagePath);

  const framePath = await composeBgFrame(rawImagePath);
  const fontPath = await ensureFont();
  const musicPath = getRandomTrack();
  const outputPath = path.join(OUTPUT_DIR, `reel_${Date.now()}.mp4`);

  const titleLines = wrapTitle(listing.title);
  const price = listing.price || '';

  // Build ffmpeg drawtext filters
  const filters = [];
  const lineHeight = 75;
  const titleBaseY = VIDEO_HEIGHT - 380 - (titleLines.length - 1) * lineHeight;
  const font = ffmpegEscape(fontPath);

  // Shop name at top
  filters.push(`drawtext=fontfile='${font}':text='@themoonpenguinshop':fontcolor=white:fontsize=46:x=(w-text_w)/2:y=95`);

  // Title lines
  titleLines.forEach((line, i) => {
    const y = titleBaseY + i * lineHeight;
    filters.push(`drawtext=fontfile='${font}':text='${ffmpegEscape(line)}':fontcolor=white:fontsize=56:x=(w-text_w)/2:y=${y}`);
  });

  // Price text
  if (price) {
    const priceY = VIDEO_HEIGHT - 230;
    filters.push(`drawtext=fontfile='${font}':text='${ffmpegEscape(price)}':fontcolor=white:fontsize=44:x=(w-text_w)/2:y=${priceY}`);
  }

  // CTA at bottom
  filters.push(`drawtext=fontfile='${font}':text='Shop via link in bio':fontcolor=white:fontsize=36:x=(w-text_w)/2:y=${VIDEO_HEIGHT - 105}`);

  const filterString = filters.join(',');

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(framePath)
      .inputOptions([`-loop 1`, `-t ${VIDEO_DURATION}`])
      .input(musicPath)
      .inputOptions([`-t ${VIDEO_DURATION}`])
      .videoFilters(filterString)
      .outputOptions([
        '-c:v libx264',
        '-tune stillimage',
        '-c:a aac',
        '-b:a 192k',
        `-af volume=${MUSIC_VOLUME}`,
        '-pix_fmt yuv420p',
        '-shortest',
        '-movflags +faststart'
      ])
      .output(outputPath)
      .on('end', resolve)
      .on('error', (err) => {
        console.error('ffmpeg error:', err.message);
        reject(err);
      })
      .run();
  });

  console.log(`✅ Reel created: ${outputPath}`);
  return outputPath;
}

function cleanup(videoPath) {
  try {
    const files = [videoPath, path.join(OUTPUT_DIR, 'frame.png'), path.join(OUTPUT_DIR, 'resized.png'), path.join(OUTPUT_DIR, 'product_raw.jpg')];
    files.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
  } catch (e) {
    console.warn('Cleanup warning:', e.message);
  }
}

module.exports = { createReel, cleanup };
