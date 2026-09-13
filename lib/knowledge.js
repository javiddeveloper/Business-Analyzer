// Ported from business-generator-light's dashboard/lib/knowledge.js, trimmed
// for this product: no self-growing suggestions queue (that relied on the
// Product Owner's multi-turn chat memory to spot "durable facts" — a
// single-shot diff review has no equivalent conversation to mine facts
// from), and no pdf-parse dependency (md/txt only, to keep this package
// dependency-free — add pdf-parse back the same way the original did if
// you need PDF uploads).
//
// Same file-based persistence style: one .md file per entry under
// data/knowledge/, plus an index.json for metadata. This is injected into
// every review prompt (see lib/reviewer.js) so project-specific standards
// ("every migration must be reversible", "no console.log in production
// code", …) get enforced consistently across every MR.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.CR_DATA_DIR ? path.resolve(process.env.CR_DATA_DIR) : path.join(ROOT, 'data');
const KNOWLEDGE_DIR = path.join(DATA, 'knowledge');
const INDEX_PATH = path.join(KNOWLEDGE_DIR, 'index.json');

// How much knowledge gets folded into a single review prompt. This used to be
// a flat 6000 characters for every engine — a number that fit nothing in
// particular and, since these notes are Persian (roughly one token per 1.2
// characters, not the ~3.6 a character budget implicitly assumes), really
// meant ~5000 tokens rather than the ~1700 it looked like. It now comes from
// the active engine's window; see lib/contextBudget.js.
function defaultBudgetChars() {
  return require('./contextBudget').budgetFor().knowledgeChars;
}

function ensureDir() {
  fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
}

function loadIndex() {
  ensureDir();
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveIndex(idx) {
  ensureDir();
  fs.writeFileSync(INDEX_PATH, JSON.stringify(idx, null, 2));
}

function makeId(title, idx) {
  const base = String(title || 'note')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || ('note-' + Date.now().toString(36));
  let id = base;
  let n = 2;
  while (idx[id]) {
    id = base + '-' + n;
    n++;
  }
  return id;
}

function filePathFor(id) {
  return path.join(KNOWLEDGE_DIR, id + '.md');
}

function list() {
  const idx = loadIndex();
  return Object.entries(idx)
    .map(([id, meta]) => ({ id, ...meta }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function read(id) {
  if (!id || !/^[\w-]+$/.test(id)) return null;
  try {
    return fs.readFileSync(filePathFor(id), 'utf8');
  } catch (e) {
    return null;
  }
}

function write({ id, title, content, source }) {
  ensureDir();
  const idx = loadIndex();
  const now = Date.now();
  const finalId = id && idx[id] ? id : makeId(title, idx);
  fs.writeFileSync(filePathFor(finalId), content || '');
  idx[finalId] = {
    title: title || finalId,
    source: source || 'written',
    updatedAt: now,
    createdAt: (idx[finalId] && idx[finalId].createdAt) || now,
    sizeChars: (content || '').length,
  };
  saveIndex(idx);
  return { id: finalId, ...idx[finalId] };
}

function remove(id) {
  if (!id || !/^[\w-]+$/.test(id)) return false;
  const idx = loadIndex();
  if (!idx[id]) return false;
  try { fs.unlinkSync(filePathFor(id)); } catch (e) {}
  delete idx[id];
  saveIndex(idx);
  return true;
}

// Extracts plain text from an uploaded file. Only md/txt for now — see the
// module comment above for why pdf-parse was left out of this port.
async function extractText(ext, base64) {
  const lower = (ext || '').toLowerCase();
  const buffer = Buffer.from(base64, 'base64');
  if (lower === 'md' || lower === 'txt') {
    return buffer.toString('utf8');
  }
  return '[سیستم]: این فرمت فایل پشتیبانی نمی‌شود (فقط md/txt). لطفاً محتوا را به‌صورت متن وارد کنید.';
}

// Builds the block folded into every review's system prompt. Returns '' when
// the knowledge base is empty so callers don't need a special case.
// Newest-first (list() already sorts by updatedAt) and — unlike before — a
// note that doesn't fit no longer ends the loop: one oversized note used to
// hide every smaller note behind it. Whatever is left out is named inside the
// block, because a standard the model was never shown must not be
// indistinguishable from a standard the model ignored.
function contextBlockDetailed(maxChars) {
  const budget = maxChars || defaultBudgetChars();
  const entries = list();
  if (!entries.length) return { text: '', included: [], skipped: [] };
  let body = '';
  const included = [];
  const skipped = [];
  for (const meta of entries) {
    const content = read(meta.id);
    if (!content) continue;
    const chunk = '### ' + meta.title + '\n' + content.trim() + '\n\n';
    if (body.length + chunk.length > budget) { // don't truncate mid-entry
      skipped.push({ id: meta.id, title: meta.title, chars: chunk.length });
      continue;
    }
    body += chunk;
    included.push({ id: meta.id, title: meta.title });
  }
  if (!body) return { text: '', included: [], skipped };
  let text = '\n\n📚 پایگاه دانش پروژه (استانداردهایی که تیم تعریف کرده — این‌ها را هم در ریویو لحاظ کن):\n' + body;
  if (skipped.length) {
    text += `\n(${skipped.length} یادداشت دیگر به دلیل سقف حجم context در این ریویو به مدل داده نشد: ${skipped.map((s) => s.title).join('، ')})\n`;
  }
  return { text, included, skipped };
}

function contextBlock(maxChars) {
  return contextBlockDetailed(maxChars).text;
}

module.exports = { list, read, write, remove, extractText, contextBlock, contextBlockDetailed, KNOWLEDGE_DIR };
