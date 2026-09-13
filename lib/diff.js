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

// The same rendering, but bounded by a character budget — and honest about
// what it cut.
//
// Two things the old `annotate(...).slice(0, MAX)` in reviewer.js got wrong:
//  1. It cut mid-line, so the model's last visible line was half a statement
//     with a line number that no longer matched anything real.
//  2. It reported only a boolean, so the report could say "truncated" but not
//     "the last 340 lines of this file, from line 812 on, were not reviewed".
// Returns { text, truncated, keptLines, droppedLines, lastLine }; lastLine is
// the highest new-file line number that actually reached the model, which is
// what makes the omission nameable in the report.
// Below this much room there is no point cutting into a line — a 40-character
// fragment of a minified bundle tells the model nothing and only invites a
// finding about syntax that is really just the cut.
const MIN_PARTIAL_LINE_CHARS = 200;

function annotateWithin(diffText, maxChars) {
  const kept = [];
  let size = 0;
  let truncated = false;
  let droppedLines = 0;
  let keptCodeLines = 0;
  let lastLine = null;

  for (const hunk of parseDiff(diffText)) {
    const header = `@@ line ${hunk.newStart} @@`;
    const rendered = [header];
    for (const line of hunk.lines) {
      const num = line.newLine == null ? '    ' : String(line.newLine).padStart(4, ' ');
      const sign = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
      rendered.push(`${num} |${sign}${line.text}`);
    }
    for (let i = 0; i < rendered.length; i++) {
      let row = rendered[i];
      if (!truncated && maxChars > 0 && size + row.length + 1 > maxChars) {
        // A single line longer than the whole budget has to be cut inside the
        // line, or the file contributes nothing at all: minified bundles,
        // one-line JSON fixtures and long string literals are all real, and
        // dropping the only line in them would hand the model an empty file
        // while the report claimed it was reviewed. Preferring line
        // boundaries is right; degrading to "send nothing" is not.
        // Only a line that could never fit *any* budget is cut inside itself.
        // A line that simply does not fit the room left over is a normal
        // boundary stop — the rest of the file is reported as dropped and the
        // reader can see exactly where coverage ended.
        const room = maxChars - size - 1;
        const unfittable = row.length + 1 > maxChars;
        if (unfittable && room > MIN_PARTIAL_LINE_CHARS) {
          row = row.slice(0, room) + ' ⟪…ادامه‌ی همین خط بریده شد⟫';
          kept.push(row);
          size = maxChars;
          truncated = true;
          if (i > 0) {
            keptCodeLines++;
            const line = hunk.lines[i - 1];
            if (line.newLine != null) lastLine = line.newLine;
          }
          continue;
        }
        truncated = true;
      }
      if (truncated) {
        if (i > 0) droppedLines++; // hunk headers aren't code lines
        continue;
      }
      kept.push(row);
      size += row.length + 1;
      if (i > 0) {
        keptCodeLines++;
        const line = hunk.lines[i - 1];
        if (line.newLine != null) lastLine = line.newLine;
      }
    }
  }

  let text = kept.join('\n');
  if (truncated) {
    text += `\n[... ${droppedLines} خط باقی‌مانده‌ی این فایل${lastLine != null ? ` (از خط ${lastLine} به بعد)` : ''} به دلیل سقف حجم context به مدل داده نشد ...]`;
  }
  return { text, truncated, keptLines: kept.length, droppedLines, lastLine };
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
  annotateWithin,
  addedLines,
  countChanges,
  isTestPath,
  isSourcePath,
  extOf,
};
