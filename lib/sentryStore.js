// A local copy of what Sentry told us, so the page still works when Sentry
// does not.
//
// This install goes down often enough that the team asked for it. Without a
// stored copy, a Sentry outage turns the errors page into an error message —
// at exactly the moment somebody is most likely to be looking for the crash
// that is taking production down.
//
// Deliberately a *snapshot*, not a second source of truth. Sentry stays
// authoritative: a served snapshot always says how old it is and that it is
// a snapshot, because a stale count shown as current is worse than no count
// at all. Nothing here is ever written back to Sentry.
const fs = require('fs');
const path = require('path');
const { atomicWriteFileSync } = require('./atomicWrite');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.CR_DATA_DIR ? path.resolve(process.env.CR_DATA_DIR) : path.join(ROOT, 'data');
const ISSUES_PATH = path.join(DATA, 'sentry-issues.json');
const DETAILS_PATH = path.join(DATA, 'sentry-details.json');

// Details carry a full stack trace each, so they are capped by count rather
// than left to grow with every issue anyone ever expanded. The list snapshot
// is one document per project and stays small on its own.
const MAX_DETAILS = 200;

function read(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function write(file, data) {
  fs.mkdirSync(DATA, { recursive: true });
  atomicWriteFileSync(file, JSON.stringify(data, null, 2));
}

// ---- the issue list --------------------------------------------------------

// Keyed by the project set and window the list was fetched for, since the
// same project looks different over 24h and 90d and serving one as the other
// would be quietly wrong.
function listKey(projects, statsPeriod) {
  return `${(projects || []).slice().sort().join(',')}|${statsPeriod}`;
}

function saveIssues(projects, statsPeriod, issues) {
  const all = read(ISSUES_PATH, {});
  all[listKey(projects, statsPeriod)] = { at: Date.now(), issues };
  write(ISSUES_PATH, all);
}

function loadIssues(projects, statsPeriod) {
  const hit = read(ISSUES_PATH, {})[listKey(projects, statsPeriod)];
  return hit && Array.isArray(hit.issues) ? hit : null;
}

// ---- one issue's detail ----------------------------------------------------

// Saved whenever an issue is expanded, so the stack trace of a crash somebody
// already looked at survives the outage too — that is usually the one being
// worked on.
function saveDetail(issueId, detail) {
  const all = read(DETAILS_PATH, {});
  all[String(issueId)] = { at: Date.now(), detail };

  // Oldest-first eviction. A trace nobody has opened in months is the one
  // least likely to be wanted during an outage.
  const keys = Object.keys(all);
  if (keys.length > MAX_DETAILS) {
    keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
    for (const k of keys.slice(0, keys.length - MAX_DETAILS)) delete all[k];
  }
  write(DETAILS_PATH, all);
}

function loadDetail(issueId) {
  const hit = read(DETAILS_PATH, {})[String(issueId)];
  return hit && hit.detail ? hit : null;
}

function stats() {
  const lists = read(ISSUES_PATH, {});
  const details = read(DETAILS_PATH, {});
  const ats = Object.values(lists).map((v) => v.at).filter(Boolean);
  return {
    lists: Object.keys(lists).length,
    details: Object.keys(details).length,
    newestAt: ats.length ? Math.max(...ats) : null,
  };
}

module.exports = { saveIssues, loadIssues, saveDetail, loadDetail, stats, listKey, MAX_DETAILS };
