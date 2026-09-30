// src/state.js
// Tiny JSON key/value helpers for the ./data volume (persists across deploys
// on Railway). Used to remember recent scripts, styles, hashtags, etc. so the
// pipeline can avoid repeating itself.

const fs = require('fs');
const path = require('path');

const DATA_DIR = './data';

function readState(name, fallback) {
  try {
    const file = path.join(DATA_DIR, `${name}.json`);
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeState(name, value) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, `${name}.json`), JSON.stringify(value, null, 2));
  } catch (e) {
    console.warn(`State write warning (${name}):`, e.message);
  }
}

// Push onto a capped "recent" list stored under `name`.
function pushRecent(name, item, max = 12) {
  const list = readState(name, []);
  list.push(item);
  writeState(name, list.slice(-max));
}

// Pick a random element, avoiding anything in `avoid` when possible.
function pickFresh(options, avoid = []) {
  const fresh = options.filter(o => !avoid.includes(typeof o === 'object' ? o.id : o));
  const pool = fresh.length ? fresh : options;
  return pool[Math.floor(Math.random() * pool.length)];
}

// Anthropic responses can contain several blocks (e.g. when web search is on);
// join just the text.
function textFromMessage(message) {
  return (message.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();
}

module.exports = { readState, writeState, pushRecent, pickFresh, textFromMessage };
