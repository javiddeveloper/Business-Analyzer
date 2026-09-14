// Two tiny file-backed stores, same "no database" style as knowledge.js:
//  - settings: the dashboard's auto-review switches
//  - reviewed: the last head sha reviewed per MR, so auto-review doesn't
//    re-review the same commits every poll (and re-post the same comment).
const fs = require('fs');
const path = require('path');
const { atomicWriteFileSync } = require('./atomicWrite');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.CR_DATA_DIR ? path.resolve(process.env.CR_DATA_DIR) : path.join(ROOT, 'data');
const SETTINGS_PATH = path.join(DATA, 'settings.json');
const REVIEWED_PATH = path.join(DATA, 'reviewed.json');
const APPROVED_PATH = path.join(DATA, 'approved.json');

const DEFAULT_SETTINGS = {
  // Off by default: turning it on starts spending money on every open MR the
  // token can see, so that has to be a deliberate click, not a default.
  autoReview: false,
  // Matches the team's own manual review process (review/README.md): the
  // report lives in review/MR-<iid>.md, full stop — GitLab only gets a
  // comment when a human explicitly asks for one via glab. Off by default
  // for every unattended trigger (auto-review AND webhook); the dashboard's
  // manual "کامنت روی گیت‌لب ثبت شود" checkbox is the one place this is
  // opt-in per run.
  autoPost: false,
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
  // Include Maintainers and Owners in the developer roster, not just members
  // with the Developer role. Off by default because the roster answers "who
  // is being reviewed", and in the normal case maintainers are the people
  // doing the reviewing — putting them in the list would score the reviewer
  // on the same page as the reviewed. It is on a switch rather than fixed
  // because that split is not universal: on a small team the lead ships
  // features too, and leaving them out then means the analytics page simply
  // omits a chunk of the work the team actually did.
  includeMaintainers: false,
  // Commits review/MR-<iid>.md straight onto the MR's own source branch via
  // the GitLab API after each review. Off by default, and for the same
  // reason autoPost and autoApprove are: this writes to the team's
  // repository, on a branch that usually belongs to somebody else, and that
  // has to be a deliberate choice rather than something the tool starts
  // doing the first time it runs.
  pushReport: false,
  // Whole-project review: check the MR out into a throwaway worktree and let
  // the Claude CLI agent browse the codebase (read callers, tests, the old
  // implementation) instead of only judging the diff. Only possible on the
  // claude-cli engine — HTTP models have no tools — and on by default there,
  // since seeing the project is the entire reason to use that engine.
  agentMode: true,
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
  atomicWriteFileSync(file, JSON.stringify(obj, null, 2));
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
  next.agentMode = !!next.agentMode;
  next.pushReport = !!next.pushReport;
  next.includeMaintainers = !!next.includeMaintainers;
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

// Which MRs this bot has already approved — the merge-order gate in
// jobs.js reads this to decide whether an earlier-created MR is "out of the
// way" yet before letting a later one auto-approve.
function isApproved(key) {
  return !!readJson(APPROVED_PATH, {})[key];
}

function markApproved(key) {
  const all = readJson(APPROVED_PATH, {});
  all[key] = true;
  writeJson(APPROVED_PATH, all);
}

module.exports = { getSettings, saveSettings, lastReviewedSha, markReviewed, isApproved, markApproved };
