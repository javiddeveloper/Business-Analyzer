// Manual developer ratings — the user's own judgment call, kept completely
// separate from computeAutoScore's heuristic (activity.js). Shown side by
// side in the dashboard rather than blended into one number, since averaging
// a human opinion with an automated metric would hide which one a given
// score actually came from.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.CR_DATA_DIR ? path.resolve(process.env.CR_DATA_DIR) : path.join(ROOT, 'data');
const RATINGS_PATH = path.join(DATA, 'ratings.json');

// Fixed 1-5 parameters — a short, consistent set beats a free-form form
// nobody fills the same way twice.
const PARAMS = [
  { key: 'quality', label: 'کیفیت کد' },
  { key: 'speed', label: 'سرعت انجام کار' },
  { key: 'communication', label: 'ارتباط و شفافیت گزارش پیشرفت' },
  { key: 'reliability', label: 'قابل‌اعتماد بودن (تعهد به deadline)' },
];

function ensureDir() {
  fs.mkdirSync(DATA, { recursive: true });
}

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(RATINGS_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeAll(all) {
  ensureDir();
  fs.writeFileSync(RATINGS_PATH, JSON.stringify(all, null, 2));
}

function get(author) {
  return readAll()[author] || null;
}

// scores: { quality: 1-5, speed: 1-5, ... } — partial updates allowed.
function set(author, scores, note) {
  const all = readAll();
  const existing = all[author] || { scores: {} };
  const clamped = {};
  for (const p of PARAMS) {
    const v = scores && scores[p.key];
    if (v == null) { clamped[p.key] = existing.scores[p.key] ?? null; continue; }
    clamped[p.key] = Math.max(1, Math.min(5, Number(v) || 1));
  }
  all[author] = { scores: clamped, note: note != null ? String(note).slice(0, 1000) : (existing.note || ''), updatedAt: Date.now() };
  writeAll(all);
  return all[author];
}

function overall(rating) {
  if (!rating) return null;
  const vals = PARAMS.map((p) => rating.scores[p.key]).filter((v) => v != null);
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 20); // 1-5 -> 20-100
}

module.exports = { PARAMS, get, set, overall };
