// src/video.js
// Builds the Reel video. Every render randomly combines:
//   - a LAYOUT  (classic: photo on top + text panel, fullbleed: photo fills the
//                screen, card: photo framed on a colored background)
//   - a MOTION  (slow zoom in, slow zoom out, pan, or "detail cuts" that move
//                between close-ups of the piece)
//   - a THEME   (background/text colors for the card layout)
//   - a HOOK line, CTA wording and length
// and avoids reusing the previous post's layout+motion so consecutive posts
// look different.

const sharp = require('sharp');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { readState, writeState, pickFresh } = require('./state');

const OUTPUT_DIR = './tmp';
const MUSIC_DIR = './';
const W = 1080;
const H = 1920;
const SCALE = 2; // plates are rendered at 2x so zoom/pan stays smooth
const FPS = 30;
const MUSIC_VOLUME = 0.3;
const VOICEOVER_MUSIC_VOLUME = 0.03;

const LAYOUTS = ['classic', 'fullbleed', 'card'];
const MOTIONS = ['zoom_in', 'zoom_out', 'pan', 'detail_cuts'];

const THEMES = [
  { id: 'cream', bg: '#f5f0eb', text: '#2b2320', sub: '#7a6a5f' },
  { id: 'noir', bg: '#141414', text: '#e8d5a3', sub: '#b8a57a' },
  { id: 'rose', bg: '#e9d3cf', text: '#3d2426', sub: '#7d5457' },
  { id: 'sage', bg: '#d8dfd0', text: '#27331f', sub: '#56654b' },
  { id: 'midnight', bg: '#1d2340', text: '#f1e6cf', sub: '#b9b0d6' },
  { id: 'plum', bg: '#3b2433', text: '#f3dfe6', sub: '#caa3b5' },
];

const HOOKS = [
  'New in the shop', 'Handmade', 'One of a kind', 'Gift idea',
  'Made in small batches', 'Just listed', 'Made by hand', 'A little treasure',
];

const CTAS = ['Shop via link in bio', 'Link in bio', 'Tap the link in bio', 'Available now - link in bio'];

const pick = arr => arr[Math.floor(Math.random() * arr.length)];

function ensureDirs() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function getRandomTrack() {
  const tracks = fs.readdirSync(MUSIC_DIR).filter(f => f.match(/^\d+\.mp3$/));
  if (tracks.length === 0) throw new Error('No mp3 tracks found in root directory');
  const recent = readState('recent_tracks', []);
  const choice = pickFresh(tracks, recent);
  writeState('recent_tracks', [...recent, choice].slice(-3));
  console.log(`🎵 Selected track: ${choice}`);
  return path.join(MUSIC_DIR, choice);
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
  // Etsy titles are keyword-stuffed ("Black Kitten Pill Case: Brass cat on
  // resin inlay, ..."); the part before the colon reads much better on screen.
  const short = title.split(/[:|]/)[0].trim() || title;
  const words = short.split(/\s+/);
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

// Pick layout/motion/theme, avoiding an exact repeat of recent posts.
function chooseLook() {
  const recent = readState('recent_looks', []);
  const last = recent[recent.length - 1];
  // Never the same layout twice in a row, never the same motion twice in a row.
  const layout = pickFresh(LAYOUTS, last ? [last.layout] : []);
  const motion = pickFresh(MOTIONS, recent.slice(-2).map(r => r.motion));
  const theme = pickFresh(THEMES, recent.slice(-2).map(r => r.theme));
  const hook = pickFresh(HOOKS, recent.slice(-3).map(r => r.hook));
  const cta = pick(CTAS);
  const look = { layout, motion, theme: theme.id, hook, cta };
  writeState('recent_looks', [...recent, look].slice(-10));
  console.log(`🎨 Look: ${layout} / ${motion} / ${theme.id} / "${hook}"`);
  return { ...look, themeObj: theme };
}

// ---------- still images (built with sharp) ----------

// Where the moving photo sits on screen for each layout. Only the photo
// moves; the background, frame, gradients and text stay put.
// 'blurfill' is used instead of 'fullbleed' for wide photos, where a 9:16
// crop would cut the product off: the whole photo sits in the middle over a
// blurred, darkened copy of itself.
function windowFor(layout, aspect = 1) {
  if (layout === 'blurfill') {
    const h = Math.min(1400, Math.round(W / aspect / 2) * 2);
    return { x: 0, y: Math.round((H - h) / 2 / 2) * 2 - 80, w: W, h };
  }
  if (layout === 'classic') return { x: 0, y: 0, w: W, h: 1350 };
  if (layout === 'card') return { x: 100, y: 330, w: 880, h: 880 };
  return { x: 0, y: 0, w: W, h: H }; // fullbleed
}

// The photo, cropped to the window and rendered at 2x so zoom/pan is smooth.
async function buildPlate(imagePath, look) {
  const win = windowFor(look.layout, look.aspect);
  const platePath = path.join(OUTPUT_DIR, 'plate.png');
  await sharp(imagePath)
    .resize(win.w * SCALE, win.h * SCALE, { fit: 'cover', position: 'attention' })
    .png().toFile(platePath);
  return platePath;
}

// Static layer underneath the photo (cream panel, or colored card + frame).
async function buildBase(look) {
  const basePath = path.join(OUTPUT_DIR, 'base.png');
  const win = windowFor(look.layout, look.aspect);
  const composites = [];
  let bg = look.layout === 'classic' ? look.themeObj.bg : '#f5f0eb';
  if (look.layout === 'blurfill') {
    await sharp(look.imagePath).resize(W, H, { fit: 'cover' }).blur(40).modulate({ brightness: 0.6 })
      .png().toFile(basePath);
    return basePath;
  }
  if (look.layout === 'card') {
    bg = look.themeObj.bg;
    const b = 14;
    composites.push({ input: Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <defs><filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="22"/></filter></defs>
      <rect x="${win.x - b}" y="${win.y - b + 16}" width="${win.w + b * 2}" height="${win.h + b * 2}" fill="black" opacity="0.35" filter="url(#s)"/>
      <rect x="${win.x - b}" y="${win.y - b}" width="${win.w + b * 2}" height="${win.h + b * 2}" fill="#fbf8f3"/>
    </svg>`), top: 0, left: 0 });
  }
  await sharp({ create: { width: W, height: H, channels: 4, background: bg } })
    .composite(composites).png().toFile(basePath);
  return basePath;
}

// Static layer on top of the photo so white text stays readable.
async function buildOverlay(look) {
  const overlayPath = path.join(OUTPUT_DIR, 'overlay.png');
  let svg;
  if (look.layout === 'card') {
    svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"></svg>`;
  } else {
    const bottomOpacity = look.layout === 'classic' ? 0 : 0.8; // classic has a solid panel instead
    svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="t" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="black" stop-opacity="0.55"/><stop offset="100%" stop-color="black" stop-opacity="0"/></linearGradient>
        <linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="black" stop-opacity="0"/><stop offset="100%" stop-color="black" stop-opacity="${bottomOpacity}"/></linearGradient>
      </defs>
      <rect x="0" y="0" width="${W}" height="220" fill="url(#t)"/>
      <rect x="0" y="${H - 700}" width="${W}" height="700" fill="url(#b)"/>
    </svg>`;
  }
  await sharp(Buffer.from(svg)).png().toFile(overlayPath);
  return overlayPath;
}

// ---------- ffmpeg filter builders ----------

let ZP_SIZE = `${W}x${H}`;
function zoompan(z, x, y, frames) {
  return `zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${ZP_SIZE}:fps=${FPS}`;
}

const CENTER_X = 'iw/2-(iw/zoom/2)';
const CENTER_Y = 'ih/2-(ih/zoom/2)';

// Returns a filter_complex fragment that takes [0:v] (single still) and
// produces [mv] of `duration` seconds.
function motionFilter(look, duration) {
  const win = windowFor(look.layout, look.aspect);
  ZP_SIZE = `${win.w}x${win.h}`;
  const N = Math.round(duration * FPS);
  const amt = (0.08 + Math.random() * 0.08).toFixed(3); // 8-16% zoom
  const focusY = 0.5;

  switch (look.motion) {
    case 'zoom_in':
      return `[0:v]${zoompan(`1+${amt}*on/${N}`, CENTER_X, `ih*${focusY}-(ih/zoom*${focusY})`, N)}[mv]`;
    case 'zoom_out':
      return `[0:v]${zoompan(`${1 + +amt}-${amt}*on/${N}`, CENTER_X, `ih*${focusY}-(ih/zoom*${focusY})`, N)}[mv]`;
    case 'pan': {
      const z = 1.15;
      const dir = pick(['down', 'up', 'right', 'left']);
      const prog = `on/${N}`;
      const x = dir === 'right' ? `(iw-iw/zoom)*${prog}` : dir === 'left' ? `(iw-iw/zoom)*(1-${prog})` : CENTER_X;
      const y = dir === 'down' ? `(ih-ih/zoom)*${prog}` : dir === 'up' ? `(ih-ih/zoom)*(1-${prog})` : `(ih-ih/zoom)*${focusY}`;
      return `[0:v]${zoompan(z, x, y, N)}[mv]`;
    }
    case 'detail_cuts':
    default: {
      // Three shots: wide -> close-up A -> close-up B, joined with crossfades.
      const xf = 0.4;
      const seg = (duration + 2 * xf) / 3;
      const n = Math.round(seg * FPS);
      const fx = () => (0.3 + Math.random() * 0.4).toFixed(2);
      const fy = () => (focusY - 0.12 + Math.random() * 0.24).toFixed(2);
      const [ax, ay, bx, by] = [fx(), fy(), fx(), fy()];
      const zA = (1.5 + Math.random() * 0.3).toFixed(2);
      const zB = (1.3 + Math.random() * 0.2).toFixed(2);
      return [
        `[0:v]split=3[s1][s2][s3]`,
        `[s1]${zoompan(`1+0.05*on/${n}`, CENTER_X, `ih*${focusY}-(ih/zoom*${focusY})`, n)},setpts=PTS-STARTPTS[c1]`,
        `[s2]${zoompan(`${zA}+0.08*on/${n}`, `iw*${ax}-(iw/zoom*${ax})`, `ih*${ay}-(ih/zoom*${ay})`, n)},setpts=PTS-STARTPTS[c2]`,
        `[s3]${zoompan(`${zB}-0.08*on/${n}`, `iw*${bx}-(iw/zoom*${bx})`, `ih*${by}-(ih/zoom*${by})`, n)},setpts=PTS-STARTPTS[c3]`,
        `[c1][c2]xfade=transition=fade:duration=${xf}:offset=${(seg - xf).toFixed(2)}[x1]`,
        `[x1][c3]xfade=transition=${pick(['fade', 'smoothleft', 'smoothup', 'circleopen'])}:duration=${xf}:offset=${(2 * seg - 2 * xf).toFixed(2)},trim=duration=${duration}[mv]`,
      ].join(';');
    }
  }
}

// drawtext reading from a file avoids all the quote/colon escaping pitfalls
// (product titles with apostrophes used to be a problem).
let textFileCounter = 0;
function drawText(font, text, { size, color, y, start = 0, fade = 0.5, x = '(w-text_w)/2', shadow = true }) {
  const file = path.join(OUTPUT_DIR, `txt_${textFileCounter++}.txt`);
  fs.writeFileSync(file, text);
  const alpha = start > 0 ? `:alpha='if(lt(t,${start}),0,min(1,(t-${start})/${fade}))'` : '';
  const sh = shadow ? ':shadowcolor=black@0.45:shadowx=2:shadowy=2' : '';
  return `drawtext=fontfile='${font}':textfile='${file}':fontcolor=${color}:fontsize=${size}:x=${x}:y=${y}${alpha}${sh}`;
}

function textFilters(font, look, listing, { voiceover = false } = {}) {
  const card = look.layout === 'card' || look.layout === 'classic'; // text sits on a solid theme color
  const main = card ? look.themeObj.text : 'white';
  const sub = card ? look.themeObj.sub : 'white@0.85';
  const shadow = !card;
  const f = [drawText(font, '@themoonpenguinshop', look.layout === 'card'
    ? { size: 44, color: main, y: 150, shadow: false }
    : { size: 44, color: 'white', y: 95, shadow: true })];

  // Voiceover reels show the same text (helps people watching with sound off).

  const lines = wrapTitle(listing.title);
  const lh = 74;
  const titleTop = look.layout === 'card' ? 1330 : look.layout === 'classic' ? 1480 : H - 400 - (lines.length - 1) * lh;
  f.push(drawText(font, look.hook.toUpperCase(), { size: 34, color: sub, y: titleTop - 70, start: 0.3, shadow }));
  lines.forEach((line, i) => {
    f.push(drawText(font, line, { size: 58, color: main, y: titleTop + i * lh, start: 0.7 + i * 0.15, shadow }));
  });
  const afterTitle = titleTop + lines.length * lh + 20;
  if (listing.price) f.push(drawText(font, listing.price, { size: 44, color: main, y: card ? afterTitle : H - 230, start: 1.3, shadow }));
  f.push(drawText(font, look.cta, { size: 36, color: sub, y: card ? afterTitle + 100 : H - 115, start: 1.8, shadow }));
  return f;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
    let err = '';
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-800)}`)));
  });
}

async function render(listing, opts = {}) {
  try {
    return await renderOnce(listing, opts);
  } catch (err) {
    // One bad layout/motion combo shouldn't cost the whole post: retry once
    // with the plainest look before giving up.
    console.warn('⚠️  Render failed, retrying with card / zoom_in:', err.message.split('\n')[0]);
    return renderOnce(listing, { ...opts, safe: true });
  }
}

async function renderOnce(listing, { voiceoverPath = null, safe = false } = {}) {
  ensureDirs();
  const look = chooseLook();
  if (safe) { look.layout = 'card'; look.motion = 'zoom_in'; console.log('🎨 Safe look: card / zoom_in'); }

  const rawImagePath = path.join(OUTPUT_DIR, 'product_raw.jpg');
  await downloadImage(listing.imageUrl, rawImagePath);
  const meta = await sharp(rawImagePath).metadata();
  look.aspect = meta.width / meta.height;
  look.imagePath = rawImagePath;
  if (look.layout === 'fullbleed' && look.aspect > 0.9) look.layout = 'blurfill';
  const platePath = await buildPlate(rawImagePath, look);
  const basePath = await buildBase(look);
  const overlayPath = await buildOverlay(look);
  const win = windowFor(look.layout, look.aspect);
  const font = await ensureFont();
  const musicPath = getRandomTrack();

  let duration;
  if (voiceoverPath) {
    duration = 15;
    try {
      const probe = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${voiceoverPath}"`).toString().trim();
      duration = Math.ceil(parseFloat(probe)) + 1;
    } catch (probeErr) {
      console.warn(`⚠️  Could not read voiceover duration, defaulting to ${duration}s:`, probeErr.message);
    }
  } else {
    duration = pick([8, 9, 10, 11, 12]);
  }

  const outputPath = path.join(OUTPUT_DIR, `reel_${voiceoverPath ? 'vo_' : ''}${Date.now()}.mp4`);
  const video = [
    motionFilter(look, duration),
    `[1:v][mv]overlay=${win.x}:${win.y}[ph];[ph][2:v]overlay=0:0,${textFilters(font, look, listing, { voiceover: !!voiceoverPath }).join(',')},format=yuv420p[vout]`,
  ];
  const audio = voiceoverPath
    // Voiceover is mono and music is stereo -- force a stereo result, since
    // amix collapsing to mono made Instagram reject the upload (status ERROR).
    ? `[3:a]volume=${VOICEOVER_MUSIC_VOLUME}[music];[4:a]volume=1.0[vo];[music][vo]amix=inputs=2:duration=first,aformat=channel_layouts=stereo:sample_rates=44100[aout]`
    : `[3:a]volume=${MUSIC_VOLUME},afade=t=out:st=${duration - 1.5}:d=1.5,aformat=channel_layouts=stereo:sample_rates=44100[aout]`;

  const args = [
    '-i', platePath,
    '-loop', '1', '-i', basePath,
    '-loop', '1', '-i', overlayPath,
    '-t', String(duration), '-i', musicPath,
    ...(voiceoverPath ? ['-i', voiceoverPath] : []),
    '-filter_complex', [...video, audio].join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-t', String(duration),
    '-r', String(FPS),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    outputPath,
  ];

  console.log(`🎬 Rendering ${duration}s ${voiceoverPath ? 'voiceover ' : ''}reel for: ${listing.title}`);
  await runFfmpeg(args);
  console.log(`✅ Reel created: ${outputPath}`);
  return outputPath;
}

// Standard text overlay reel
async function createReel(listing) {
  return render(listing);
}

// Voiceover ad reel -- product image with motion + AI voiceover + quiet music
async function createVoiceoverReel(listing, voiceoverPath) {
  return render(listing, { voiceoverPath });
}

function cleanup(videoPath) {
  try {
    const files = [
      videoPath,
      path.join(OUTPUT_DIR, 'plate.png'),
      path.join(OUTPUT_DIR, 'overlay.png'),
      path.join(OUTPUT_DIR, 'base.png'),
      path.join(OUTPUT_DIR, 'product_raw.jpg'),
      path.join(OUTPUT_DIR, 'voiceover.mp3'),
      ...fs.readdirSync(OUTPUT_DIR).filter(f => /^txt_\d+\.txt$/.test(f)).map(f => path.join(OUTPUT_DIR, f)),
    ];
    files.forEach(f => { if (f && fs.existsSync(f)) fs.unlinkSync(f); });
  } catch (e) {
    console.warn('Cleanup warning:', e.message);
  }
}

module.exports = { createReel, createVoiceoverReel, cleanup, LAYOUTS, MOTIONS };
