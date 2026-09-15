// Generic file-based TTL cache — same "no database" style as the rest of
// this project (state.js, knowledge.js). Built for the developer analytics
// page: computing one developer's data means dozens of GitLab API calls
// (one repository/commits lookup per MR) and can take 15+ seconds even with
// apiFetch's timeout in place. A few minutes of staleness is a fair trade
// against paying that cost on every click, every page reopen.
const fs = require('fs');
const path = require('path');
const { atomicWriteFileSync } = require('./atomicWrite');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.CR_DATA_DIR ? path.resolve(process.env.CR_DATA_DIR) : path.join(ROOT, 'data');

function filePathFor(name) {
  // name comes from our own call sites (constant strings), never user input —
  // still restricted to a safe charset so a typo can't become a path escape.
  const safe = String(name).replace(/[^a-z0-9-]/gi, '_');
  return path.join(DATA, `cache-${safe}.json`);
}

function readAll(name) {
  try {
    return JSON.parse(fs.readFileSync(filePathFor(name), 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeAll(name, all) {
  fs.mkdirSync(DATA, { recursive: true });
  atomicWriteFileSync(filePathFor(name), JSON.stringify(all));
}

// Runs `compute()` only on a miss (entry absent, expired, or `force`) —
// always returns { value, at, fromCache }, so a caller can show "computed
// just now" vs "from N minutes ago" without a second cache lookup.
async function cached(name, key, ttlMs, compute, { force = false } = {}) {
  if (!force) {
    const all = readAll(name);
    const entry = all[key];
    if (entry && Date.now() - entry.at <= ttlMs) {
      return { value: entry.value, at: entry.at, fromCache: true };
    }
  }
  const value = await compute();
  const all = readAll(name); // re-read: another request may have written meanwhile
  all[key] = { value, at: Date.now() };
  writeAll(name, all);
  return { value, at: all[key].at, fromCache: false };
}

// Read without computing on a miss. For callers where the value is a nice
// extra rather than the answer: the assignee suggestion on a Sentry issue
// would otherwise trigger a full analytics build per developer — dozens of
// GitLab calls — and turn opening one error into a half-minute wait for
// something advisory.
function peek(name, key, ttlMs) {
  const entry = readAll(name)[key];
  if (!entry) return null;
  if (ttlMs != null && Date.now() - entry.at > ttlMs) return null;
  return { value: entry.value, at: entry.at };
}

function invalidate(name, key) {
  const all = readAll(name);
  if (key == null) { writeAll(name, {}); return; }
  delete all[key];
  writeAll(name, all);
}

module.exports = { cached, peek, invalidate };
