// Tests for the review pipeline's pure logic: diff parsing (which decides
// where an inline comment can legally go), the deterministic checks, finding
// normalisation, and comment de-duplication across rounds.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.CR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-review-test-'));

const diffLib = require('../lib/diff');
const checks = require('../lib/checks');
const reviewer = require('../lib/reviewer');
const publish = require('../lib/publish');

const SAMPLE_DIFF = [
  '@@ -10,6 +10,8 @@ class Foo {',
  '     val a = 1',
  '-    val old = 2',
  '+    val b = 3',
  '+    val c = 4',
  '     val d = 5',
  '@@ -40,3 +42,4 @@',
  '     tail()',
  '+    extra()',
].join('\n');

test('parseDiff tracks real old/new line numbers across hunks', () => {
  const hunks = diffLib.parseDiff(SAMPLE_DIFF);
  assert.equal(hunks.length, 2);

  const first = hunks[0].lines;
  assert.deepEqual(
    first.map((l) => [l.type, l.oldLine, l.newLine]),
    [
      ['ctx', 10, 10],
      ['del', 11, null],
      ['add', null, 11],
      ['add', null, 12],
      ['ctx', 12, 13],
    ]
  );
  // Second hunk restarts from its own header, it doesn't continue counting.
  assert.equal(hunks[1].lines[0].newLine, 42);
  assert.equal(hunks[1].lines[1].newLine, 43);
});

test('commentableLines only accepts lines that exist in the diff', () => {
  const map = diffLib.commentableLines(SAMPLE_DIFF);
  assert.ok(map.has(11), 'added line is commentable');
  assert.ok(map.has(13), 'context line is commentable');
  assert.ok(map.has(43), 'added line in the second hunk is commentable');
  assert.ok(!map.has(200), 'a line outside every hunk is not commentable');
  assert.equal(map.get(11).type, 'add');
  assert.equal(map.get(13).type, 'ctx');
});

test('annotate shows the new-file line numbers the model is asked to cite', () => {
  const text = diffLib.annotate(SAMPLE_DIFF);
  assert.match(text, /  11 \|\+ {4}val b = 3/);
  assert.match(text, / {5}\|- {4}val old = 2/, 'deleted lines carry no new-file number');
});

test('classify skips lockfiles, generated output and binaries but keeps source', () => {
  const skip = (p) => diffLib.classify({ new_path: p, diff: '@@ -1 +1 @@\n+x' }).skip;
  assert.ok(skip('package-lock.json'));
  assert.ok(skip('app/src/main/assets/logo.png'));
  assert.ok(skip('node_modules/lib/index.js'));
  assert.ok(skip('web/dist/bundle.min.js'));
  assert.ok(skip('lib/model.freezed.dart'));
  assert.ok(!skip('app/src/main/kotlin/Foo.kt'));
  assert.ok(diffLib.classify({ new_path: 'a.kt', deleted_file: true, diff: 'x' }).skip);
});

test('secret scan flags a real credential and ignores env lookups and placeholders', () => {
  const files = [{
    path: 'app/Config.kt',
    diff: [
      '@@ -1,0 +1,5 @@',
      '+val token = "glpat-abcdefghij1234567890XY"',
      '+val fromEnv = System.getenv("API_KEY")',
      '+val apiKey = "<your-api-key-here>"',
      '+val password = "hunter2000secret"',
      '+val ok = BuildConfig.CLIENT_SECRET',
    ].join('\n'),
  }];
  const found = checks.scanSecrets(files);
  const lines = found.map((f) => f.line);
  assert.deepEqual(lines, [1, 4], 'only the two real hardcoded credentials');
  assert.ok(found.every((f) => f.severity === 'High' && f.source === 'auto'));
});

test('debug-leftover scan skips test files', () => {
  const prod = checks.scanDebugLeftovers([{ path: 'app/Foo.kt', diff: '@@ -1,0 +1,2 @@\n+println("here")\n+// TODO: fix' }]);
  assert.equal(prod.length, 2);
  const inTests = checks.scanDebugLeftovers([{ path: 'app/src/test/FooTest.kt', diff: '@@ -1,0 +1,1 @@\n+println("here")' }]);
  assert.equal(inTests.length, 0);
});

test('missing-tests check fires only for non-trivial source changes with no test touched', () => {
  const big = { path: 'app/Foo.kt', diff: '@@ -1,0 +1,40 @@\n' + Array.from({ length: 40 }, (_, i) => `+line ${i}`).join('\n') };
  assert.equal(checks.checkMissingTests([big]).length, 1);
  assert.equal(checks.checkMissingTests([big, { path: 'app/src/test/FooTest.kt', diff: '@@ -1,0 +1,1 @@\n+test' }]).length, 0);
  const tiny = { path: 'app/Foo.kt', diff: '@@ -1,0 +1,2 @@\n+val a = 1\n+val b = 2' };
  assert.equal(checks.checkMissingTests([tiny]).length, 0, 'a two-line change needs no test to justify it');
});

test('normalizeFindings drops line numbers the model invented', () => {
  const { files } = reviewer.prepareFiles([{ new_path: 'app/Foo.kt', diff: SAMPLE_DIFF }]);
  const out = reviewer.normalizeFindings(
    [
      { file: 'app/Foo.kt', line: 11, severity: 'High', title: 'real', note: 'n' },
      { file: 'app/Foo.kt', line: 999, severity: 'Low', title: 'invented', note: 'n' },
      { file: 'app/Foo.kt', line: 12, severity: 'nonsense', title: 'bad severity', note: 'n' },
    ],
    files
  );
  assert.equal(out[0].line, 11);
  assert.equal(out[1].line, null, 'a line outside the diff must not become a comment position');
  assert.equal(out[1].claimedLine, 999);
  assert.ok(out[1].lineUnverified);
  assert.equal(out[2].severity, 'Medium', 'unknown severity falls back to Medium');
});

// A "this doesn't match the ticket" finding is judged against a Jira
// description that is regularly stale or broader than the one MR — worth
// telling a human about, never solid enough to block an approve. So it's
// pinned to Low no matter what the model claims, in both review paths.
test('task-mismatch findings are pinned to Low so a stale ticket can never block an approve', () => {
  const { files } = reviewer.prepareFiles([{ new_path: 'app/Foo.kt', diff: SAMPLE_DIFF }]);
  const out = reviewer.normalizeFindings(
    [
      { file: 'app/Foo.kt', line: 11, severity: 'High', category: 'task-mismatch', title: 'با تسک نمی‌خواند', note: 'n' },
      { file: 'app/Foo.kt', line: 11, severity: 'High', category: 'logic', title: 'باگ واقعی', note: 'n' },
    ],
    files
  );
  assert.equal(out[0].severity, 'Low', 'model-claimed High on a ticket mismatch is clamped');
  assert.equal(out[0].category, 'task-mismatch');
  assert.equal(out[1].severity, 'High', 'a real code finding keeps the severity the model gave it');
  assert.equal(reviewer.decide([out[0]]), 'APPROVE', 'a ticket mismatch alone still approves');
});

test('the Jira ticket reaches the review prompt, and its absence leaves no empty section', () => {
  const { files } = reviewer.prepareFiles([{ new_path: 'app/Foo.kt', diff: SAMPLE_DIFF }]);
  const withTicket = reviewer.buildUserPrompt({
    mr: { title: 'x' }, batch: files, batchIndex: 0, batchCount: 1,
    jiraIssue: { key: 'EM-2600', summary: 'محاسبه‌ی گردش حساب بدهی', status: 'In Review', description: 'باید سقف سنی چک شود.' },
  });
  assert.match(withTicket, /EM-2600/);
  assert.match(withTicket, /محاسبه‌ی گردش حساب بدهی/);
  assert.match(withTicket, /سقف سنی/, 'the description is what lets the review judge intent, not just the title');
  assert.match(withTicket, /task-mismatch/, 'the model is told how to report a gap');

  const withoutTicket = reviewer.buildUserPrompt({ mr: { title: 'x' }, batch: files, batchIndex: 0, batchCount: 1 });
  assert.ok(!/تسک جیرا/.test(withoutTicket), 'no Jira, no ticket section');
});

test('batching packs every file instead of truncating the diff', () => {
  const files = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.kt`, annotated: 'x'.repeat(6000) }));
  const batches = reviewer.buildBatches(files);
  assert.ok(batches.length > 1, 'oversized input is split, not cut');
  assert.equal(batches.flat().length, 5, 'no file is dropped');
});

test('decision follows the findings, not the model\'s mood', () => {
  assert.equal(reviewer.decide([{ severity: 'Low' }]), 'APPROVE');
  assert.equal(reviewer.decide([{ severity: 'Medium' }]), 'REQUEST_CHANGES');
  assert.equal(reviewer.decide([{ severity: 'Low' }, { severity: 'High' }]), 'REQUEST_CHANGES');
  assert.equal(reviewer.decide([]), 'APPROVE');
});

test('fingerprints are stable per finding and differ across lines', () => {
  const a = { file: 'a.kt', line: 10, title: 'Null pointer' };
  const b = { file: 'a.kt', line: 11, title: 'Null pointer' };
  assert.equal(publish.fingerprint(a), publish.fingerprint({ ...a }), 'same finding → same fingerprint across rounds');
  assert.notEqual(publish.fingerprint(a), publish.fingerprint(b));
});

test('buildPosition anchors to the diff and refuses lines outside it', () => {
  const { files } = reviewer.prepareFiles([{ new_path: 'app/Foo.kt', diff: SAMPLE_DIFF }]);
  const refs = { base_sha: 'b', start_sha: 's', head_sha: 'h' };

  const added = publish.buildPosition({ finding: { line: 11 }, file: files[0], diffRefs: refs });
  assert.deepEqual(added, {
    position_type: 'text', base_sha: 'b', start_sha: 's', head_sha: 'h',
    new_path: 'app/Foo.kt', old_path: 'app/Foo.kt', new_line: 11,
  });

  const context = publish.buildPosition({ finding: { line: 13 }, file: files[0], diffRefs: refs });
  assert.equal(context.old_line, 12, 'a context line needs both sides');

  assert.equal(publish.buildPosition({ finding: { line: 999 }, file: files[0], diffRefs: refs }), null);
});

test('summary renders findings that never made it inline, and hides the ones that did', () => {
  const body = publish.buildSummary({
    decision: 'REQUEST_CHANGES',
    summary: 'خلاصه',
    findings: [
      { severity: 'High', category: 'security', title: 'inline one', note: 'n', file: 'a.kt', line: 3, postedInline: true },
      { severity: 'Medium', category: 'process', title: 'no line', note: 'n', file: null, line: null },
    ],
    stats: { files: 2, skipped: 1, promptTokens: 10, completionTokens: 5 },
    inlineCount: 1,
    headSha: 'abcdef1234567890',
    model: 'gpt-4o-mini',
  });
  assert.ok(body.includes('no line'));
  assert.ok(!body.includes('inline one'), 'a finding already posted on its line is not repeated');
  assert.ok(body.includes('| 🔴 High | 1 |'));
  assert.ok(body.includes('<!-- coder-review:summary-abcdef123456 -->'), 'carries a marker so the same sha is not summarised twice');
});
