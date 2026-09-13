// 👍/👎 on individual findings — the accuracy signal this tool otherwise has
// no way to produce.
//
// Every other number this project reports about itself (batches run, files
// skipped, tokens spent) describes what the tool *did*, never whether what
// it said was actually right. Without some version of this, the tool has no
// defense against "the AI made stuff up again" beyond a shrug — and no way
// to notice a real accuracy problem (a bad prompt, a degraded model) before
// a developer complains about it in a retro.
//
// Deliberately per-finding rather than per-review: a review with 8 findings
// where 7 are sharp and 1 is nonsense is common, and a single review-level
// rating would average that into meaninglessness. Keyed on the same
// (projectId, mrIid, fingerprint) triple publish.js already uses to dedupe
// comments across re-reviews, so a vote on a finding survives the MR being
// re-reviewed as long as the finding itself didn't change.
const fs = require('fs');
const path = require('path');
const { atomicWriteFileSync } = require('./atomicWrite');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.CR_DATA_DIR ? path.resolve(process.env.CR_DATA_DIR) : path.join(ROOT, 'data');
const FEEDBACK_PATH = path.join(DATA, 'feedback.json');

function ensureDir() {
  fs.mkdirSync(DATA, { recursive: true });
}

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(FEEDBACK_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeAll(all) {
  ensureDir();
  atomicWriteFileSync(FEEDBACK_PATH, JSON.stringify(all, null, 2));
}

function key(projectId, mrIid, fingerprint) {
  return `${projectId}!${mrIid}!${fingerprint}`;
}

// vote: 'up' | 'down' | null (null clears a previously-cast vote — someone
// changed their mind, or clicked the same button twice to undo it).
function setVote({ projectId, mrIid, fingerprint, vote, category, severity, source }) {
  const all = readAll();
  const k = key(projectId, mrIid, fingerprint);
  if (vote !== 'up' && vote !== 'down') {
    delete all[k];
  } else {
    all[k] = { vote, category: category || null, severity: severity || null, source: source || null, at: Date.now() };
  }
  writeAll(all);
  return all[k] || null;
}

function getVotes({ projectId, mrIid }) {
  const all = readAll();
  const prefix = `${projectId}!${mrIid}!`;
  const out = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v.vote;
  }
  return out;
}

// The accuracy rate this tool can actually claim: of every finding anyone
// bothered to vote on, what fraction were marked useful. A finding nobody
// voted on says nothing either way and is excluded, not counted as a miss —
// silence is not disagreement.
function accuracy({ category = null } = {}) {
  const all = readAll();
  let up = 0;
  let down = 0;
  const byCategory = {};
  for (const v of Object.values(all)) {
    if (category && v.category !== category) continue;
    const bucket = v.category || 'نامشخص';
    if (!byCategory[bucket]) byCategory[bucket] = { up: 0, down: 0 };
    if (v.vote === 'up') { up++; byCategory[bucket].up++; }
    else if (v.vote === 'down') { down++; byCategory[bucket].down++; }
  }
  const total = up + down;
  return {
    total,
    up,
    down,
    rate: total ? Math.round((up / total) * 100) : null,
    byCategory: Object.entries(byCategory).map(([cat, c]) => ({
      category: cat,
      up: c.up,
      down: c.down,
      total: c.up + c.down,
      rate: (c.up + c.down) ? Math.round((c.up / (c.up + c.down)) * 100) : null,
    })),
  };
}

module.exports = { setVote, getVotes, accuracy };
