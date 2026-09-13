// Manual developer ratings — the user's own judgment call, kept completely
// separate from computeAutoScore's heuristic (activity.js). Shown side by
// side in the dashboard rather than blended into one number, since averaging
// a human opinion with an automated metric would hide which one a given
// score actually came from.
//
// Ratings are per calendar month ("2026-09"), not one running number per
// person: someone's speed/quality/communication in a given month is what a
// manager is actually judging when they open this page mid-month, and a
// single lifetime score would either freeze on the first rating ever given
// or blur every month together. `overall(author)` (no month) still answers
// "their most recent rating" for anywhere that wants one number, e.g. the
// developer-list card.
const fs = require('fs');
const { atomicWriteFileSync } = require('./atomicWrite');
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
  atomicWriteFileSync(RATINGS_PATH, JSON.stringify(all, null, 2));
}

function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Old file shape was `{ [author]: { scores, note, updatedAt } }` — one
// rating ever, no month. Read transparently as if it were already filed
// under "the month it was actually saved" isn't recoverable (updatedAt is a
// timestamp, so it *is* — use that), so an upgrade never loses a rating
// someone already entered.
function migrateAuthorEntry(entry) {
  if (!entry) return {};
  if (entry.months) return entry.months;
  if (entry.scores) {
    const month = entry.updatedAt ? monthKeyFromMs(entry.updatedAt) : currentMonthKey();
    return { [month]: { scores: entry.scores, note: entry.note || '', updatedAt: entry.updatedAt || Date.now() } };
  }
  return {};
}

function monthKeyFromMs(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthsFor(author) {
  const all = readAll();
  return migrateAuthorEntry(all[author]);
}

// A specific month's rating, or null if nothing was ever entered for it.
function get(author, month) {
  const months = monthsFor(author);
  return months[month || currentMonthKey()] || null;
}

// Every month this person has a rating for, most-recent first — the list
// the dashboard's "امتیازدهی دستی" month picker is built from.
function listMonths(author) {
  const months = monthsFor(author);
  return Object.keys(months).sort().reverse();
}

// The most recent calendar month that has a rating on file, regardless of
// when it was actually saved — used where the UI wants one badge number
// (e.g. the developer-list card) rather than a specific month's score.
function latest(author) {
  const months = monthsFor(author);
  const keys = Object.keys(months).sort().reverse();
  return keys.length ? months[keys[0]] : null;
}

// scores: { quality: 1-5, speed: 1-5, ... } — partial updates allowed
// (missing keys keep that month's previous value, if any).
function set(author, month, scores, note) {
  const key = month || currentMonthKey();
  const all = readAll();
  const months = migrateAuthorEntry(all[author]);
  const existing = months[key] || { scores: {} };
  const clamped = {};
  for (const p of PARAMS) {
    const v = scores && scores[p.key];
    if (v == null) { clamped[p.key] = existing.scores[p.key] ?? null; continue; }
    clamped[p.key] = Math.max(1, Math.min(5, Number(v) || 1));
  }
  months[key] = { scores: clamped, note: note != null ? String(note).slice(0, 1000) : (existing.note || ''), updatedAt: Date.now() };
  all[author] = { months };
  writeAll(all);
  return months[key];
}

function overall(rating) {
  if (!rating) return null;
  const vals = PARAMS.map((p) => rating.scores[p.key]).filter((v) => v != null);
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 20); // 1-5 -> 20-100
}

module.exports = { PARAMS, get, set, overall, listMonths, latest, currentMonthKey };
