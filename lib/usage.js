// Model usage accounting — every completed review appends one record here,
// so "how much did this cost us" has an actual answer instead of living only
// inside each job's stats until the job list is cleared on restart.
//
// Deliberately separate from activity.js's review log: that file exists to
// answer "how good is this person's code", keyed by author; this one exists
// to answer "how much are we spending", keyed by day and engine. Mixing them
// would mean every future change to one has to think about the other.
//
// File-based, same style as the rest of this project. Capped like
// activity.js — a token count from six months ago is not actionable, and an
// unbounded log is a slow-growing liability nobody would notice until the
// file was too big to read.
const fs = require('fs');
const path = require('path');
const { atomicWriteFileSync } = require('./atomicWrite');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.CR_DATA_DIR ? path.resolve(process.env.CR_DATA_DIR) : path.join(ROOT, 'data');
const USAGE_PATH = path.join(DATA, 'usage.json');
const MAX_ENTRIES = 20000; // ~ years of normal review volume at a few hundred/week

function ensureDir() {
  fs.mkdirSync(DATA, { recursive: true });
}

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8'));
  } catch (e) {
    return [];
  }
}

function writeAll(arr) {
  ensureDir();
  atomicWriteFileSync(USAGE_PATH, JSON.stringify(arr.slice(-MAX_ENTRIES), null, 2));
}

function dayKey(at) {
  return new Date(at).toISOString().slice(0, 10); // YYYY-MM-DD, UTC — stable regardless of server TZ
}

// One record per completed review call (whichever engine actually answered —
// the fallback chain in jobs.js can mean the configured engine and the one
// billed are different, so `provider` here is always the one that ran).
function record({ projectId, mrIid, provider, mode, promptTokens, completionTokens, at = Date.now() }) {
  const all = readAll();
  all.push({
    at,
    day: dayKey(at),
    projectId: projectId ?? null,
    mrIid: mrIid ?? null,
    provider: provider || 'unknown',
    mode: mode || 'batch', // 'agent' | 'batch'
    promptTokens: Number(promptTokens) || 0,
    completionTokens: Number(completionTokens) || 0,
  });
  writeAll(all);
}

// Aggregates the last `days` days (default 30) into totals a dashboard can
// show at a glance: reviews run, tokens by kind, and a breakdown per engine
// so "which engine is actually costing us tokens" doesn't require reading
// the raw log.
function summary({ days = 30, now = Date.now() } = {}) {
  const all = readAll();
  const since = now - days * 86400000;
  const inWindow = all.filter((r) => r.at >= since);
  const todayKey = dayKey(now);

  const byProvider = {};
  let promptTokens = 0;
  let completionTokens = 0;
  let reviews = 0;
  let todayReviews = 0;
  let todayPromptTokens = 0;
  let todayCompletionTokens = 0;

  for (const r of inWindow) {
    reviews++;
    promptTokens += r.promptTokens;
    completionTokens += r.completionTokens;
    if (!byProvider[r.provider]) byProvider[r.provider] = { reviews: 0, promptTokens: 0, completionTokens: 0 };
    byProvider[r.provider].reviews++;
    byProvider[r.provider].promptTokens += r.promptTokens;
    byProvider[r.provider].completionTokens += r.completionTokens;
    if (r.day === todayKey) {
      todayReviews++;
      todayPromptTokens += r.promptTokens;
      todayCompletionTokens += r.completionTokens;
    }
  }

  return {
    days,
    reviews,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    today: {
      reviews: todayReviews,
      promptTokens: todayPromptTokens,
      completionTokens: todayCompletionTokens,
      totalTokens: todayPromptTokens + todayCompletionTokens,
    },
    byProvider: Object.entries(byProvider).map(([provider, v]) => ({ provider, ...v, totalTokens: v.promptTokens + v.completionTokens })),
  };
}

module.exports = { record, summary, readAll };
