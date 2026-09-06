// Unified-diff parsing.
//
// Two things depend on this:
//  1. Inline comments — GitLab rejects a discussion whose position isn't an
//     actual line of the diff, so every line the model cites has to be checked
//     against the real hunks before it's posted.
//  2. Line numbers in the prompt — the model can only cite a line number if it
//     was shown one, so diffs go to the model annotated with the file's real
//     new-file line numbers rather than as a raw patch.
const path = require('path');

// Files whose diffs are noise for a reviewer: lockfiles, generated output,
// vendored code, binaries. Reviewing them burns tokens and produces findings
// nobody can act on ("this lockfile hash changed").
const SKIP_EXACT = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json',
  'composer.lock', 'Gemfile.lock', 'poetry.lock', 'Pipfile.lock', 'go.sum',
  'Cargo.lock', 'gradle.lockfile', 'pubspec.lock', 'Podfile.lock',
]);
const SKIP_DIR = /(^|\/)(node_modules|vendor|dist|build|out|\.next|\.nuxt|coverage|__snapshots__|Pods)(\/|$)/;
const SKIP_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'svg', 'pdf', 'psd',
  'zip', 'gz', 'tar', 'rar', '7z', 'jar', 'aar', 'war', 'apk', 'aab', 'ipa',
  'so', 'dll', 'dylib', 'exe', 'bin', 'class', 'o', 'a',
  'ttf', 'otf', 'woff', 'woff2', 'eot', 'mp3', 'mp4', 'mov', 'avi', 'webm',
]);
const SKIP_GENERATED = /\.(min\.(js|css)|g\.dart|freezed\.dart|pb\.go|generated\.[a-z]+)$|(^|\/)[^/]*_pb2\.py$|\.designer\.cs$/i;

const SOURCE_EXT = new Set([
  'kt', 'kts', 'java', 'swift', 'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go',
  'rs', 'php', 'cs', 'cpp', 'cc', 'c', 'h', 'hpp', 'm', 'mm', 'dart', 'scala',
  'sh', 'sql', 'vue', 'svelte',
]);

const TEST_PATH = /(^|\/)(test|tests|spec|__tests__|androidTest|commonTest|jvmTest|iosTest)(\/|$)|(test|spec)\.[a-z]+$|Test\.[a-z]+$|Tests\.[a-z]+$/i;

function extOf(p) {
  return path.extname(String(p || '')).replace('.', '').toLowerCase();
}

function isTestPath(p) {
  return TEST_PATH.test(String(p || ''));
}

function isSourcePath(p) {
  return SOURCE_EXT.has(extOf(p));
}

// Decide whether a changed file is worth sending to the model.
// Returns { skip, reason } — reason is shown in the report so a skipped file
// is visible, not silently dropped.
function classify(change) {
  const p = change.new_path || change.old_path || '';
  const base = path.basename(p);
  if (change.deleted_file) return { skip: true, reason: 'فایل حذف شده' };
  if (SKIP_EXACT.has(base)) return { skip: true, reason: 'lockfile' };
  if (SKIP_DIR.test(p)) return { skip: true, reason: 'مسیر تولیدشده/vendor' };
  if (SKIP_EXT.has(extOf(p))) return { skip: true, reason: 'فایل باینری/دارایی' };
  if (SKIP_GENERATED.test(p)) return { skip: true, reason: 'کد تولیدشده' };
  if (!change.diff) return { skip: true, reason: 'بدون محتوای دیف' };
  if (change.renamed_file && change.diff.trim() === '') return { skip: true, reason: 'فقط تغییر نام' };
  return { skip: false, reason: '' };
}

// Parse a unified diff body into hunks with per-line old/new line numbers.
function parseDiff(diffText) {
  const hunks = [];
  let current = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of String(diffText || '').split('\n')) {
    const header = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      oldLine = parseInt(header[1], 10);
      newLine = parseInt(header[2], 10);
      current = { oldStart: oldLine, newStart: newLine, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;              // preamble (--- / +++ / index) — ignored
    if (raw.startsWith('\\')) continue;  // "\ No newline at end of file"

    const marker = raw[0];
    const text = raw.slice(1);
    if (marker === '+') {
      current.lines.push({ type: 'add', newLine, oldLine: null, text });
      newLine++;
    } else if (marker === '-') {
      current.lines.push({ type: 'del', newLine: null, oldLine, text });
      oldLine++;
    } else {
      // ' ' context, or a truly empty line in the patch body.
      current.lines.push({ type: 'ctx', newLine, oldLine, text: marker === ' ' ? text : raw });
      oldLine++;
      newLine++;
    }
  }
  return hunks;
}

// Map of new-file line number → { type, oldLine }, i.e. every line a comment
// can legally be anchored to on the "after" side of the diff.
function commentableLines(diffText) {
  const map = new Map();
  for (const hunk of parseDiff(diffText)) {
    for (const line of hunk.lines) {
      if (line.newLine != null) map.set(line.newLine, { type: line.type, oldLine: line.oldLine });
    }
  }
  return map;
}

// Render a diff for the model with real line numbers in the margin, so a
// finding can name the line it's about.
function annotate(diffText) {
  const out = [];
  for (const hunk of parseDiff(diffText)) {
    out.push(`@@ line ${hunk.newStart} @@`);
    for (const line of hunk.lines) {
      const num = line.newLine == null ? '    ' : String(line.newLine).padStart(4, ' ');
      const sign = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
      out.push(`${num} |${sign}${line.text}`);
    }
  }
  return out.join('\n');
}

function addedLines(diffText) {
  const added = [];
  for (const hunk of parseDiff(diffText)) {
    for (const line of hunk.lines) {
      if (line.type === 'add') added.push({ line: line.newLine, text: line.text });
    }
  }
  return added;
}

function countChanges(diffText) {
  let added = 0;
  let removed = 0;
  for (const hunk of parseDiff(diffText)) {
    for (const line of hunk.lines) {
      if (line.type === 'add') added++;
      else if (line.type === 'del') removed++;
    }
  }
  return { added, removed };
}

module.exports = {
  classify,
  parseDiff,
  commentableLines,
  annotate,
  addedLines,
  countChanges,
  isTestPath,
  isSourcePath,
  extOf,
};
