// A record of who changed what, for the handful of actions that actually
// matter to get an answer for later: "who turned on auto-approve", "who
// rewrote GITLAB_TOKEN from the settings panel", "why did this MR get
// approved". Without this, checkAdminAuth's own doc comment says it best —
// admin access "can spend money and read GitLab" — and there was no trail
// of what it had actually been used for.
//
// This project has no user accounts (ADMIN_TOKEN is one shared secret, or
// nothing at all on localhost — see server.js's checkAdminAuth), so "who"
// here means the request's IP, not a person's identity. That is a real
// limit, not a bug: worth knowing when reading this log, not worth solving
// by inventing accounts this project otherwise deliberately has none of.
//
// File-based, capped, same style as activity.js.
const fs = require('fs');
const path = require('path');
const { atomicWriteFileSync } = require('./atomicWrite');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.CR_DATA_DIR ? path.resolve(process.env.CR_DATA_DIR) : path.join(ROOT, 'data');
const AUDIT_PATH = path.join(DATA, 'audit.json');
const MAX_ENTRIES = 5000;

function ensureDir() {
  fs.mkdirSync(DATA, { recursive: true });
}

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8'));
  } catch (e) {
    return [];
  }
}

function writeAll(arr) {
  ensureDir();
  atomicWriteFileSync(AUDIT_PATH, JSON.stringify(arr.slice(-MAX_ENTRIES), null, 2));
}

// action: a short stable string ('settings', 'env', 'approve', 'project') —
// not free text, so the log stays filterable/groupable later.
// detail: whatever's useful to reconstruct the change. For 'env' this must
// be key names only, never values — this log itself is not a secret store.
function record({ action, actor, detail = {}, at = Date.now() }) {
  const all = readAll();
  all.push({ at, action, actor: actor || 'unknown', detail });
  writeAll(all);
}

function list({ limit = 200, action = null } = {}) {
  const all = readAll();
  const filtered = action ? all.filter((e) => e.action === action) : all;
  return filtered.slice(-limit).reverse(); // newest first
}

module.exports = { record, list };
