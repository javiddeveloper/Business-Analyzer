// A periodic copy of data/ — the score history, the activity/usage/audit
// logs, dev ratings, the knowledge base, and secrets.env itself have exactly
// one copy on disk. data/ is gitignored on purpose (it's per-deployment
// state, not source), which also means nothing else keeps a second copy of
// it. An accidental `rm -rf`, a bad disk, or a botched manual edit currently
// has no way back.
//
// Deliberately plain directory copies via fs.cpSync (built into Node — no
// zip library, keeping the project's zero-npm-dependency rule), not
// compressed archives: this data is small text/JSON, a few MB at most even
// after years of use, so the disk cost of staying uncompressed is
// negligible next to the value of being able to `cat` a backed-up file
// directly without unzipping anything to check it.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.CR_DATA_DIR ? path.resolve(process.env.CR_DATA_DIR) : path.join(ROOT, 'data');
const BACKUP_DIR = process.env.CR_BACKUP_DIR ? path.resolve(process.env.CR_BACKUP_DIR) : path.join(ROOT, 'backups');

// Kept low by default: this runs unattended (a daily timer in server.js),
// and a backup directory nobody prunes is just a slower-motion version of
// the same disk-fills-up problem the cache files (lib/cache.js) already
// have their own note about.
const DEFAULT_KEEP = 14;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// Sortable and filesystem-safe on both POSIX and Windows (no ':' — a literal
// ISO timestamp is not a legal Windows directory name).
function timestampName(at = Date.now()) {
  return new Date(at).toISOString().replace(/[:.]/g, '-');
}

// A no-op, not an error, when there's nothing to back up yet — a fresh
// install with an empty data/ is a legitimate state, not a failure.
function run({ keep = DEFAULT_KEEP } = {}) {
  if (!fs.existsSync(DATA)) return { skipped: 'no data directory yet' };
  ensureDir(BACKUP_DIR);
  const dest = path.join(BACKUP_DIR, timestampName());
  // filter drops atomicWrite's own in-flight temp files (`.<name>.<pid>.<ts>.tmp`)
  // — under normal operation none should exist, but a backup should never
  // capture a half-written file if a copy happens to race one.
  fs.cpSync(DATA, dest, { recursive: true, filter: (src) => !path.basename(src).endsWith('.tmp') });
  prune(keep);
  return { path: dest };
}

function list() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter((name) => fs.statSync(path.join(BACKUP_DIR, name)).isDirectory())
    .sort()
    .reverse() // newest first — the ISO-ish timestamp name sorts chronologically
    .map((name) => ({ name, path: path.join(BACKUP_DIR, name) }));
}

function prune(keep) {
  const all = list();
  for (const b of all.slice(keep)) {
    try {
      fs.rmSync(b.path, { recursive: true, force: true });
    } catch (e) {
      // Best-effort: a locked file on Windows (antivirus scanning it, e.g.)
      // should not crash the next scheduled backup. It gets another chance
      // to be pruned next run.
    }
  }
}

module.exports = { run, list, DEFAULT_KEEP };
