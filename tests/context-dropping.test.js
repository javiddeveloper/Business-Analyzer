// Anything the model was not shown has to be *sayable* afterwards.
//
// These cover the four places code was previously dropped without a trace:
// a diff cut mid-line, a full file cut at a fixed 4000 characters, a
// knowledge note hidden behind a bigger one, and a Jira description cut at
// 4000 characters.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.CR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-dropping-'));

const diffLib = require('../lib/diff');
const localRepo = require('../lib/localRepo');

function bigDiff(lines) {
  const rows = ['@@ -1,1 +1,' + lines + ' @@'];
  for (let i = 0; i < lines; i++) rows.push('+    val line' + i + ' = compute(' + i + ')');
  return rows.join('\n');
}

// ---- diff annotation ---------------------------------------------------

test('annotateWithin cuts on line boundaries and names the line it stopped at', () => {
  const diff = bigDiff(200);
  const full = diffLib.annotate(diff);
  const fitted = diffLib.annotateWithin(diff, 600);

  assert.equal(fitted.truncated, true);
  assert.ok(fitted.text.length < full.length);
  assert.ok(fitted.droppedLines > 0);
  assert.equal(fitted.keptLines + fitted.droppedLines, full.split('\n').length);

  // Every kept row is a whole annotated line — the old slice(0, N) could end
  // halfway through a statement, leaving the model a line number pointing at
  // half a line of code.
  for (const row of fitted.text.split('\n')) {
    if (row.startsWith('[...') || row.startsWith('@@')) continue;
    assert.match(row, /^ *\d+ \|/, 'a kept row is a complete annotated line: ' + row);
  }
  assert.match(fitted.text, /به مدل داده نشد/, 'the cut is stated in the text the model reads');
  assert.match(fitted.text, new RegExp('از خط ' + fitted.lastLine), 'the report can name where coverage stops');
});

test('annotateWithin returns the whole diff untouched when it fits', () => {
  const diff = bigDiff(3);
  const fitted = diffLib.annotateWithin(diff, 100000);
  assert.equal(fitted.truncated, false);
  assert.equal(fitted.droppedLines, 0);
  assert.equal(fitted.text, diffLib.annotate(diff));
});

// ---- full files from the local checkout --------------------------------

test('full-file context is cut to the budget and both the cut and the omission are reported', () => {
  const result = localRepo.applyContextBudget(
    { 'small.kt': 'a'.repeat(500), 'huge.kt': 'b'.repeat(50000) },
    { maxFileChars: 2000, totalChars: 3000 }
  );

  assert.equal(result.fileContents['small.kt'].length, 500, 'a file that fits arrives whole');
  assert.ok(result.truncated.some((t) => t.path === 'huge.kt'), 'the big file is reported as truncated');
  assert.match(result.fileContents['huge.kt'], /به مدل داده نشد/);
  assert.ok(result.usedChars <= result.budgetChars);
});

test('files past the whole-MR budget are named as omitted instead of silently missing', () => {
  const contents = {};
  for (let i = 0; i < 10; i++) contents['f' + i + '.kt'] = 'x'.repeat(1500);
  const result = localRepo.applyContextBudget(contents, { maxFileChars: 1500, totalChars: 4000 });

  assert.equal(Object.keys(result.fileContents).length + result.omitted.length, 10, 'every file is either sent or reported');
  assert.ok(result.omitted.length > 0);
  assert.ok(result.omitted.every((o) => o.chars === 1500));
});

test('a file that would only arrive as a sliver is omitted rather than shown as a fragment', () => {
  const result = localRepo.applyContextBudget(
    { 'a.kt': 'a'.repeat(900), 'b.kt': 'b'.repeat(9000) },
    { maxFileChars: 5000, totalChars: 1200 }
  );
  assert.equal(result.fileContents['a.kt'].length, 900);
  assert.equal(result.fileContents['b.kt'], undefined);
  assert.deepEqual(result.omitted.map((o) => o.path), ['b.kt']);
});

test('loadContext keeps reporting a bad path, and now always carries the dropped-context fields', async () => {
  const missing = await localRepo.loadContext({
    projectPath: path.join(os.tmpdir(), 'coder-review-nope-' + Date.now()), mrIid: 1, headSha: 'x', paths: ['a'],
  });
  assert.match(missing.warning, /پیدا نشد/);
  assert.deepEqual(missing.truncated, []);
  assert.deepEqual(missing.omitted, []);
});

// ---- knowledge base ----------------------------------------------------

test('a knowledge note left out for size is named in the block, and no longer hides the notes behind it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-kb-'));
  process.env.CR_DATA_DIR = dir;
  delete require.cache[require.resolve('../lib/knowledge')];
  const knowledge = require('../lib/knowledge');
  try {
    knowledge.write({ title: 'کوچک-اول', content: 'همیشه تست بنویس.' });
    knowledge.write({ title: 'بزرگ', content: 'ب'.repeat(4000) });
    knowledge.write({ title: 'کوچک-آخر', content: 'لاگ دیباگ نگذار.' });

    const detailed = knowledge.contextBlockDetailed(1000);
    const titles = detailed.included.map((e) => e.title);
    assert.ok(titles.includes('کوچک-آخر') && titles.includes('کوچک-اول'), 'both small notes survive an oversized one');
    assert.deepEqual(detailed.skipped.map((e) => e.title), ['بزرگ']);
    assert.match(detailed.text, /به مدل داده نشد/, 'the prompt itself says a standard was left out');
    assert.equal(knowledge.contextBlock(1000), detailed.text, 'the string API is the same block');
  } finally {
    delete require.cache[require.resolve('../lib/knowledge')];
    process.env.CR_DATA_DIR = path.join(os.tmpdir(), 'coder-review-dropping-restore');
  }
});

// ---- Jira description --------------------------------------------------

test('a long Jira description is cut to the engine budget and flagged, not quietly halved', async () => {
  const bridgePath = require.resolve('../lib/ai_bridge');
  const jiraPath = require.resolve('../lib/jira');
  const budgetPath = require.resolve('../lib/contextBudget');
  for (const p of [bridgePath, jiraPath, budgetPath]) delete require.cache[p];
  require.cache[bridgePath] = {
    id: bridgePath, filename: bridgePath, loaded: true,
    exports: { secret: (k) => ({ JIRA_BASE_URL: 'https://jira.tamin.ir', JIRA_API_TOKEN: 'tok', AI_PROVIDER: '9router' }[k] || '') },
  };
  const jira = require('../lib/jira');
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ key: 'EM-1', fields: { description: 'ش'.repeat(20000) } }) });
  try {
    const issue = await jira.fetchIssue('EM-1');
    assert.equal(issue.descriptionTruncated, true);
    assert.ok(issue.description.length < 20000);
    assert.match(issue.description, /به مدل داده نشد/);

    global.fetch = async () => ({ ok: true, json: async () => ({ key: 'EM-2', fields: { description: 'کوتاه' } }) });
    const short = await jira.fetchIssue('EM-2');
    assert.equal(short.description, 'کوتاه');
    assert.equal(short.descriptionTruncated, false);
  } finally {
    global.fetch = originalFetch;
    for (const p of [bridgePath, jiraPath, budgetPath]) delete require.cache[p];
  }
});

// A minified bundle, a one-line JSON fixture or a long string literal is one
// enormous line. Cutting only on line boundaries meant the whole file
// collapsed to a marker and reached the model as nothing at all, while the
// report still listed it as reviewed.
test('a single line longer than the budget is cut inside the line, not dropped whole', () => {
  const diff = require('../lib/diff');
  const oneHugeLine = ['@@ -1,0 +1,2 @@', '+' + 'x'.repeat(5000), '+short line'].join('\n');

  const cut = diff.annotateWithin(oneHugeLine, 1000);
  assert.ok(cut.text.length > 900, 'the model must still see the start of the line, got ' + cut.text.length + ' chars');
  assert.ok(cut.truncated, 'and it must be marked as truncated');
  assert.match(cut.text, /ادامه‌ی همین خط/, 'with a marker saying the cut was inside the line');

  // Too small to be worth a fragment: a 40-character sliver of a minified
  // bundle only invites a finding about the cut itself.
  const tiny = diff.annotateWithin(oneHugeLine, 100);
  assert.ok(!/ادامه‌ی همین خط/.test(tiny.text), 'below the floor it stays a plain drop');

  // The ordinary case must be untouched by all of this.
  const normal = diff.annotateWithin(['@@ -1,0 +1,3 @@', '+one', '+two', '+three'].join('\n'), 10000);
  assert.equal(normal.truncated, false);
  assert.match(normal.text, /three/);
});
