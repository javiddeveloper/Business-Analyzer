// Two append-only (capped) logs, same file-based style as the rest of this
// project:
//  - events: every relevant webhook hit — who pushed, which branch/task,
//    when. This is what actually answers "which branch/task is this
//    developer on right now", straight from GitLab's own webhook payload,
//    not a guess.
//  - reviews: the outcome of every review this service has run — decision
//    and a severity breakdown. This is the only honest basis for an
//    "accuracy" score: it's *our own* findings history, not an invented number.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.CR_DATA_DIR ? path.resolve(process.env.CR_DATA_DIR) : path.join(ROOT, 'data');
const EVENTS_PATH = path.join(DATA, 'activity-events.json');
const REVIEWS_PATH = path.join(DATA, 'activity-reviews.json');
const MAX_ENTRIES = 3000;

function ensureDir() {
  fs.mkdirSync(DATA, { recursive: true });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return [];
  }
}

function writeJson(file, arr) {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(arr.slice(-MAX_ENTRIES), null, 2));
}

// author is normalized to a stable key: username if present, else name.
function authorKey(author) {
  return String((author && (author.username || author.name)) || author || '').trim();
}

function recordEvent({ author, projectId, mrIid, branch, targetBranch, task, action, sha, title, webUrl }) {
  const events = readJson(EVENTS_PATH);
  events.push({
    author: authorKey(author),
    projectId, mrIid, branch, targetBranch, task, action, sha, title, webUrl,
    at: Date.now(),
  });
  writeJson(EVENTS_PATH, events);
}

function recordReview({ author, projectId, mrIid, decision, severityCounts, filesReviewed }) {
  const reviews = readJson(REVIEWS_PATH);
  reviews.push({
    author: authorKey(author),
    projectId, mrIid, decision, severityCounts, filesReviewed,
    at: Date.now(),
  });
  writeJson(REVIEWS_PATH, reviews);
}

function eventsFor(author) {
  const key = authorKey(author);
  return readJson(EVENTS_PATH).filter((e) => e.author === key);
}

function reviewsFor(author) {
  const key = authorKey(author);
  return readJson(REVIEWS_PATH).filter((r) => r.author === key);
}

function allAuthorsFromEvents() {
  return Array.from(new Set(readJson(EVENTS_PATH).map((e) => e.author).filter(Boolean)));
}

// A transparent, explainable 0-100 heuristic — not a claim of measuring
// actual skill. Two ingredients, both from data this service actually has:
//   - accuracy: fewer High/Medium findings per review = higher score
//   - activity: reviewed recently = full credit; nothing in 14+ days decays
//     toward 0, since "on it right now" and "went quiet a month ago" should
//     not look the same.
function computeAutoScore(author) {
  const reviews = reviewsFor(author).slice(-30); // recent window — old history shouldn't dominate
  const events = eventsFor(author);

  if (!reviews.length) {
    return { score: null, reason: 'هنوز هیچ ریویویی برای این فرد ثبت نشده — امتیازی محاسبه نمی‌شود.', reviewCount: 0 };
  }

  let weightedFindings = 0;
  for (const r of reviews) {
    const c = r.severityCounts || {};
    weightedFindings += (c.High || 0) * 3 + (c.Medium || 0) * 1.5 + (c.Low || 0) * 0.5;
  }
  const avgWeighted = weightedFindings / reviews.length;
  // 0 findings/review -> 100; ~6 weighted points/review (≈ two High) -> ~0.
  const accuracyScore = Math.max(0, 100 - avgWeighted * 16.6);

  const lastAt = Math.max(0, ...events.map((e) => e.at), ...reviews.map((r) => r.at));
  const daysSince = lastAt ? (Date.now() - lastAt) / 86400000 : 999;
  const activityScore = daysSince <= 2 ? 100 : Math.max(0, 100 - (daysSince - 2) * 12);

  const score = Math.round(accuracyScore * 0.7 + activityScore * 0.3);
  return {
    score,
    accuracyScore: Math.round(accuracyScore),
    activityScore: Math.round(activityScore),
    reviewCount: reviews.length,
    daysSinceLastActivity: Math.round(daysSince * 10) / 10,
    reason: `بر اساس ${reviews.length} ریویوی اخیر (۷۰٪ دقت/کیفیت کد بر اساس یافته‌ها، ۳۰٪ تازگی فعالیت).`,
  };
}

module.exports = { recordEvent, recordReview, eventsFor, reviewsFor, allAuthorsFromEvents, computeAutoScore, authorKey };
