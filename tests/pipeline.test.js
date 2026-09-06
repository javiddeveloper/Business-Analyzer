// End-to-end pass over the real pipeline (diff → checks → model → publish)
// with GitLab and the model stubbed. This is the test that would catch a
// break in the wiring between modules that the unit tests each pass alone.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.CR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-pipeline-'));
// A plain (non-git) directory is enough: localRepo.loadContext detects the
// missing .git and degrades to a warning instead of failing the review, and
// reportFile just needs somewhere real to write review/MR-9.md.
const FAKE_PROJECT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-project-'));

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const DIFF = [
  '@@ -1,4 +1,9 @@',
  ' class TokenStore {',
  '-    val old = 1',
  '+    val token = "glpat-abcdefghij1234567890XY"',
  '+',
  '+    fun load(id: String?) {',
  '+        repository.fetch(id!!)',
  '+    }',
  ' }',
].join('\n');

const discussions = [];
const notes = [];
let existingDiscussions = [];

stub('../lib/gitlab', {
  async getMergeRequestChanges() {
    return {
      title: 'Add token store',
      description: 'stores the token',
      diff_refs: { base_sha: 'base1', start_sha: 'start1', head_sha: 'head1' },
      changes: [
        { old_path: 'app/TokenStore.kt', new_path: 'app/TokenStore.kt', diff: DIFF },
        // Must be filtered out before the model ever sees it.
        { old_path: 'package-lock.json', new_path: 'package-lock.json', diff: '@@ -1 +1 @@\n+noise' },
      ],
    };
  },
  async listDiscussions() { return existingDiscussions; },
  async createDiscussion(projectId, mrIid, body, position) { discussions.push({ body, position }); },
  async postNote(projectId, mrIid, body) { notes.push(body); },
});

// The model finds the null-assertion bug; the hardcoded token is left to the
// deterministic check on purpose, so the test proves both paths contribute.
stub('../lib/ai_bridge', {
  secret: (k) => {
    if (k === 'AI_MODEL') return 'test-model';
    if (k === 'PROJECT_PATH') return FAKE_PROJECT_PATH;
    return '';
  },
  engineStatus: () => ({ model: 'test-model' }),
  async callModel() {
    return {
      text: JSON.stringify({
        summary: 'یک بررسی آزمایشی.',
        findings: [
          { file: 'app/TokenStore.kt', line: 6, severity: 'High', category: 'logic', title: 'null assertion روی ورودی', note: 'اگر id برابر null باشد، اینجا کرش می‌کند.', suggestion: 'id?.let { ... }' },
          { file: 'app/TokenStore.kt', line: 4321, severity: 'Low', category: 'style', title: 'خط جعلی', note: 'به خطی اشاره می‌کند که در دیف نیست.' },
        ],
      }),
      usage: { promptTokens: 100, completionTokens: 20 },
    };
  },
});

const jobs = require('../lib/jobs');

async function runOnce() {
  jobs.start({ projectId: 3, mrIid: 9, post: true });
  for (let i = 0; i < 60 && jobs.get(3, 9).status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return jobs.get(3, 9);
}

test('a full review posts inline comments with valid positions and one summary', async () => {
  const job = await runOnce();
  assert.equal(job.status, 'done', job.error || '');
  assert.equal(job.decision, 'REQUEST_CHANGES', 'a High finding must block');
  assert.equal(job.stats.files, 1, 'the lockfile was filtered out before the model');
  assert.equal(job.stats.skipped, 1);

  // The deterministic secret check and the model finding both survived.
  const titles = job.findings.map((f) => f.title);
  assert.ok(titles.some((t) => /اعتبارنامه/.test(t)), 'hardcoded token found by the check');
  assert.ok(titles.some((t) => /null assertion/.test(t)), 'bug found by the model');

  // Inline comments landed on real lines, with GitLab's required sha triplet.
  assert.ok(discussions.length >= 2, 'findings with a line got inline threads');
  for (const d of discussions) {
    assert.equal(d.position.position_type, 'text');
    assert.equal(d.position.head_sha, 'head1');
    assert.equal(d.position.new_path, 'app/TokenStore.kt');
    assert.ok(d.position.new_line >= 1 && d.position.new_line <= 9);
    assert.match(d.body, /<!-- coder-review:[a-z0-9]+ -->/, 'each carries a fingerprint for later rounds');
  }
  // The invented line number never became a position.
  assert.ok(!discussions.some((d) => d.position.new_line === 4321));

  assert.equal(notes.length, 1, 'exactly one summary comment');
  assert.match(notes[0], /REQUEST_CHANGES/);
  assert.match(notes[0], /خط جعلی/, 'a finding that could not be placed inline appears in the summary');
  assert.match(notes[0], /test-model/);
});

test('re-reviewing the same commits does not repeat comments already posted', async () => {
  // Feed the previous round's comments back as the MR's existing history.
  existingDiscussions = [
    ...discussions.map((d) => ({ notes: [{ body: d.body }] })),
    { notes: [{ body: notes[0] }] },
  ];
  const inlineBefore = discussions.length;
  const notesBefore = notes.length;

  const job = await runOnce();
  assert.equal(job.status, 'done');
  assert.equal(discussions.length, inlineBefore, 'no duplicate inline threads');
  assert.equal(notes.length, notesBefore, 'no second summary for the same head sha');
  assert.ok(job.publishResult.skippedDuplicate >= 1);
  assert.ok(job.publishResult.summarySkipped);
});
