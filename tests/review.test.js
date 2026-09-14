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
const agentReview = require('../lib/agentReview');
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

// Once a review report is committed it appears in the very MR it describes,
// so the next round read the previous round's report back as code under
// review. Seen on MR !191, where review/MR-191.md was among the 47 files
// "reviewed": tokens spent re-reading its own output, the file count (and so
// the too-big check) inflated by it, and the model free to raise findings
// about the wording of its own prior review.
test('the tool does not review its own review reports', () => {
  const verdict = (p) => diffLib.classify({ new_path: p, diff: '@@ -1 +1 @@\n+x' });
  assert.ok(verdict('review/MR-191.md').skip);
  assert.ok(verdict('some/nested/review/MR-7.md').skip);
  assert.match(verdict('review/MR-191.md').reason, /گزارش ریویو/, 'and says why, so the file is visibly skipped rather than silently gone');

  // Narrow on purpose: a hand-written note in review/ is somebody's work and
  // belongs in the review like any other file.
  assert.ok(!verdict('review/README.md').skip);
  assert.ok(!verdict('review/checklist.md').skip);
  assert.ok(!verdict('docs/MR-191.md').skip, 'only under review/, not any file that looks like one');
});

// The team's documented standard (review/README.md in the reviewed project)
// is an English report with exactly two Persian exceptions. The prompts being
// written in Persian is not the same as the report being Persian, and an
// earlier pass here got that backwards — forcing Persian output and making
// the tool contradict the process it exists to automate.
test('both review paths carry the documented report language, English with its two exceptions', () => {
  const { files } = reviewer.prepareFiles([{ new_path: 'app/Foo.kt', diff: SAMPLE_DIFF }]);
  const batchPrompt = reviewer.buildUserPrompt({ mr: { title: 'x' }, batch: files, batchIndex: 0, batchCount: 1 });
  const agentPrompt = agentReview.buildPrompt({ mr: { title: 'x' }, files, skipped: [] });

  for (const [name, prompt] of [['batch', batchPrompt], ['agent', agentPrompt]]) {
    assert.ok(prompt.includes(reviewer.OUTPUT_LANGUAGE_RULE), `${name} path states the report language`);
    assert.match(prompt, /زبان گزارش انگلیسی است/, `${name} path asks for an English report`);
    assert.match(prompt, /old_android/, `${name} path names the business-flow exception`);
    assert.match(prompt, /سناریوی مهم کسب‌وکار/, `${name} path names the missing-test exception`);
  }
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

test('an oversized MR is reported but never blocks the merge on size alone', () => {
  const files = Array.from({ length: 45 }, (_, i) => ({
    path: `app/F${i}.kt`, diff: '@@ -1,0 +1,2 @@\n+val a = 1\n+val b = 2',
  }));
  const found = checks.checkSize(files, []);
  const size = found.find((f) => /خیلی بزرگ/.test(f.title));

  assert.ok(size, 'a 45-file MR is still called out as too big to review well');
  assert.equal(size.severity, 'Low', 'but as a Low: it is a fact about the shape of the change, not a defect in the code');
  // The guarantee that actually matters, stated against decide() rather than
  // against the severity string: a big MR whose code is clean still approves.
  assert.equal(reviewer.decide(found), 'APPROVE', 'size alone must never turn into REQUEST_CHANGES');
  assert.equal(
    reviewer.decide([...found, { severity: 'Medium' }]), 'REQUEST_CHANGES',
    'a real Medium finding still blocks — this only declaws the size check'
  );
});

test('a leftover merge-conflict marker is caught deterministically, not left to the model', () => {
  const found = checks.scanConflictMarkers([{
    path: 'app/Foo.kt',
    diff: ['@@ -1,0 +1,5 @@', '+<<<<<<< HEAD', '+val a = 1', '+=======', '+val a = 2', '+>>>>>>> develop'].join('\n'),
  }]);
  assert.equal(found.length, 1, 'one finding per file — the author opens the file either way');
  assert.equal(found[0].severity, 'High');
  assert.equal(found[0].source, 'auto');
  assert.equal(found[0].line, 1);

  // Angle brackets that are not a conflict marker must not fire: a checker
  // that cries wolf gets ignored, including on the run where it is right.
  const clean = checks.scanConflictMarkers([{
    path: 'app/Bar.kt',
    diff: '@@ -1,0 +1,2 @@\n+println("<<<<<<<")\n+val x = a >>> b',
  }]);
  assert.equal(clean.length, 0);
});

test('the same finding raised by two batches is reported once, at its worst severity', () => {
  const out = reviewer.dedupeFindings([
    { file: 'a.kt', line: 4, title: 'Null pointer', severity: 'Medium', note: 'کوتاه', source: 'model' },
    { file: 'a.kt', line: 4, title: '  null POINTER ', severity: 'High', note: 'شرح کامل‌تر', suggestion: 'x = 1', source: 'model' },
    { file: 'a.kt', line: 9, title: 'Null pointer', severity: 'Low', note: 'جای دیگر', source: 'model' },
  ]);
  assert.equal(out.length, 2, 'same file+line+title is one problem, a different line is not');
  assert.equal(out[0].severity, 'High', 'the worst severity wins — a duplicate must not soften a finding');
  assert.equal(out[0].note, 'شرح کامل‌تر', 'the copy with the most context survives');
  assert.equal(out[0].suggestion, 'x = 1');
  assert.equal(out[0].duplicateCount, 2);
});

test('process findings sort below code findings of the same severity', () => {
  const sorted = reviewer.sortFindings([
    { severity: 'Medium', category: 'process', file: null, title: 'MR بزرگ است' },
    { severity: 'Medium', category: 'logic', file: 'z.kt', title: 'باگ' },
    { severity: 'High', category: 'process', file: null, title: 'ریویو ناقص ماند' },
  ]);
  assert.deepEqual(sorted.map((f) => f.title), ['ریویو ناقص ماند', 'باگ', 'MR بزرگ است']);
});

test('coverageStats names every file the review did and did not reach', () => {
  const { files, skipped } = reviewer.prepareFiles([
    { new_path: 'app/Foo.kt', diff: SAMPLE_DIFF },
    { new_path: 'package-lock.json', diff: '@@ -1 +1 @@\n+x' },
  ]);
  const stats = reviewer.coverageStats({ files, skipped, dropped: [{ path: 'app/Huge.kt' }] });
  assert.deepEqual(stats.reviewedFiles.map((f) => f.path), ['app/Foo.kt']);
  assert.equal(stats.reviewedFiles[0].added, 3, 'the per-file line counts the report prints');
  assert.deepEqual(stats.skippedFiles, [{ path: 'package-lock.json', reason: 'lockfile' }]);
  assert.deepEqual(stats.droppedFiles, ['app/Huge.kt']);
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
  // Sized off the live budget rather than a literal: the per-batch cap is
  // derived from the active engine's context window now (lib/contextBudget.js),
  // so a hardcoded 6000 chars stopped exercising the split at all once the
  // default engine's batch grew to 120K. The property under test is "an input
  // too big for one batch is split, never cut" — which is about the budget,
  // whatever the budget currently is.
  const budget = require('../lib/contextBudget').budgetFor();
  const each = Math.ceil(budget.batchChars / 2) + 1000; // three of these cannot share two batches
  const files = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.kt`, annotated: 'x'.repeat(each) }));
  const batches = reviewer.buildBatches(files);
  assert.ok(batches.length > 1, 'oversized input is split, not cut');
  assert.equal(batches.flat().length, 5, 'no file is dropped');
  for (const batch of batches) {
    const size = batch.reduce((n, f) => n + f.annotated.length, 0);
    assert.ok(batch.length === 1 || size <= budget.batchChars, 'no batch exceeds the engine budget');
  }
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
      { severity: 'High', category: 'security', title: 'inline one', note: 'حفره‌ی امنیتی', file: 'a.kt', line: 3, postedInline: true, source: 'model' },
      { severity: 'Medium', category: 'process', title: 'no line', note: 'متن مورد بی‌خط', file: null, line: null, source: 'model' },
    ],
    stats: { files: 2, skipped: 1, promptTokens: 10, completionTokens: 5 },
    inlineCount: 1,
    headSha: 'abcdef1234567890',
    model: 'gpt-4o-mini',
  });
  assert.ok(body.includes('no line'));
  assert.ok(body.includes('متن مورد بی‌خط'), 'a finding with nowhere to go inline is written out in full');
  assert.ok(!body.includes('حفره‌ی امنیتی'), 'a finding already posted on its line is not written out again');
  // …but it is still *named* in the blocking list: the author must not have to
  // open every thread to learn which items hold up the merge.
  assert.ok(body.includes('inline one'), 'a blocking finding is listed by title even when it has its own thread');
  assert.match(body, /تا این 2 مورد باز است merge نکن/);
  assert.ok(body.includes('| 🔴 High | 1 |'));
  assert.ok(body.includes('<!-- coder-review:summary-abcdef123456 -->'), 'carries a marker so the same sha is not summarised twice');
});

test('the summary keeps machine checks apart from model judgement, and states its own reach', () => {
  const body = publish.buildSummary({
    decision: 'REQUEST_CHANGES',
    summary: 'خلاصه',
    findings: [
      { severity: 'High', category: 'logic', title: 'قضاوت مدل', note: 'شرح مدل', file: 'a.kt', line: null, source: 'model' },
      { severity: 'High', category: 'security', title: 'اعتبارنامه', note: 'شرح خودکار', file: 'b.kt', line: null, source: 'auto' },
      { severity: 'Low', category: 'process', title: '3 فایل بررسی نشد', note: 'x', file: null, line: null, source: 'auto', coverage: true },
    ],
    stats: { files: 2, skipped: 3, mode: 'batch' },
    inlineCount: 0,
    duplicateCount: 2,
    headSha: 'abcdef1234567890',
    model: 'm',
  });
  assert.match(body, /### یافته‌ها[\s\S]*شرح مدل/);
  assert.match(body, /### بررسی‌های خودکار[\s\S]*شرح خودکار/);
  assert.ok(body.indexOf('### یافته‌ها') < body.indexOf('### بررسی‌های خودکار'), 'model judgement first, machine checks after');
  // A coverage item is a statement about the review, not a defect: it belongs
  // in the scope section, and must not be counted among the blocking items.
  assert.match(body, /### دامنه‌ی بررسی[\s\S]*3 فایل بررسی نشد/);
  assert.match(body, /تا این 2 مورد باز است merge نکن/);
  assert.match(body, /بیلد و تست‌ها اجرا نشده‌اند/);
  assert.match(body, /2 مورد در دورهای قبلی/, 'a re-review says what it deliberately did not repeat');
});
