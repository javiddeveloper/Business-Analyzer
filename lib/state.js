// Two tiny file-backed stores, same "no database" style as knowledge.js:
//  - settings: the dashboard's auto-review switches
//  - reviewed: the last head sha reviewed per MR, so auto-review doesn't
//    re-review the same commits every poll (and re-post the same comment).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.CR_DATA_DIR ? path.resolve(process.env.CR_DATA_DIR) : path.join(ROOT, 'data');
const SETTINGS_PATH = path.join(DATA, 'settings.json');
const REVIEWED_PATH = path.join(DATA, 'reviewed.json');

const DEFAULT_SETTINGS = {
  // Off by default: turning it on starts spending money on every open MR the
  // token can see, so that has to be a deliberate click, not a default.
  autoReview: false,
  // When auto-review runs, also post the result as a comment on the MR.
  autoPost: true,
  pollSeconds: 120,
  // Anchor findings to the exact line of the diff instead of one long comment.
  inlineComments: true,
  // A draft MR is work the author hasn't offered for review yet — reviewing it
  // automatically means commenting on unfinished code.
  skipDrafts: true,
  // Approves the MR (not merge — that stays a human action) when the review
  // comes back clean. Off by default: an approval is a real signal to
  // teammates, so turning it on is a deliberate choice, not a default.
  autoApprove: false,
};

function ensureDir() {
  fs.mkdirSync(DATA, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJson(file, obj) {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function getSettings() {
  return { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_PATH, {}) };
}

function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  // Clamp the poll interval: anything under 30s just burns GitLab API quota
  // without catching pushes any sooner in practice.
  next.pollSeconds = Math.max(30, Number(next.pollSeconds) || DEFAULT_SETTINGS.pollSeconds);
  next.autoReview = !!next.autoReview;
  next.autoPost = !!next.autoPost;
  next.inlineComments = !!next.inlineComments;
  next.skipDrafts = !!next.skipDrafts;
  next.autoApprove = !!next.autoApprove;
  writeJson(SETTINGS_PATH, next);
  return next;
}

function lastReviewedSha(key) {
  return readJson(REVIEWED_PATH, {})[key] || null;
}

function markReviewed(key, sha) {
  if (!sha) return;
  const all = readJson(REVIEWED_PATH, {});
  all[key] = sha;
  writeJson(REVIEWED_PATH, all);
}

module.exports = { getSettings, saveSettings, lastReviewedSha, markReviewed };
