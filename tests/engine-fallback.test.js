// When the configured engine refuses (the Claude subscription's session
// limit is the one that actually keeps happening), a review must not degrade
// into "here are the regex checks, good luck" — it should run on the next
// engine that has credentials and say plainly that it did.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.CR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-fallback-'));
const FAKE_PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-fallback-project-'));

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// ---- ai_bridge's own fallback picking ---------------------------------------

test('listReadyEngines skips the failed engine and lists the configured ones', () => {
  // secrets.env is read through fs on every lookup, so a scoped override of
  // readFileSync is enough to control which engines look "ready".
  const realPath = require.resolve('../lib/ai_bridge');
  delete require.cache[realPath];
  const originalRead = fs.readFileSync;
  fs.readFileSync = (p, ...rest) =>
    (String(p).endsWith('secrets.env') ? 'NINEROUTER_API_KEY=k' : originalRead(p, ...rest));
  try {
    const bridge = require('../lib/ai_bridge');
    assert.deepEqual(bridge.listReadyEngines('claude-cli'), ['9router'], 'the one engine with a key on file');
    assert.deepEqual(bridge.listReadyEngines('9router'), [], 'nothing else has a key, so there is no fallback');
  } finally {
    fs.readFileSync = originalRead;
    delete require.cache[realPath];
  }
});

test('isQuotaError recognizes the limit messages worth hopping engines for', () => {
  const { isQuotaError } = require('../lib/ai_bridge');
  assert.ok(isQuotaError("You've hit your session limit · resets 8:50pm"));
  assert.ok(isQuotaError('GapGPT 429: rate limit exceeded'));
  assert.ok(isQuotaError('سهمیه‌ی این مدل به پایان رسیده است (خطای ۴۲۹)'));
  assert.equal(isQuotaError('ENOENT: claude not found'), false);
});

// ---- the job-level fallback -------------------------------------------------

function setupJobs({ readyEngines, batchReviewSpy, batchResult }) {
  stub('../lib/ai_bridge', {
    secret: (k) => (k === 'PROJECT_PATH' ? FAKE_PROJECT : k === 'AI_PROVIDER' ? 'claude-cli' : ''),
    engineStatus: () => ({ model: 'test-model', state: 'ready' }),
    listReadyEngines: () => readyEngines.slice(),
    isQuotaError: () => true,
  });
  stub('../lib/localRepo', {
    async ensureWorktree() { return FAKE_PROJECT; },
    async loadContext() { return { fileContents: {}, warning: null }; },
  });
  stub('../lib/agentReview', {
    async review() {
      return {
        engineError: "You've hit your session limit · resets 8:50pm (Asia/Tehran)",
        decision: 'REQUEST_CHANGES',
        summary: 'ریویوی ایجنتی ناموفق بود؛ فقط بررسی‌های خودکار انجام شد.',
        findings: [{ file: null, line: null, severity: 'Medium', category: 'process', source: 'auto', title: 'MR بزرگ', note: 'n' }],
        positives: [],
        stats: { files: 4, skipped: 0, batches: 1, failedBatches: 1, promptTokens: 0, completionTokens: 0, mode: 'agent' },
      };
    },
  });
  stub('../lib/reviewer', {
    async review(args) {
      batchReviewSpy(args);
      if (batchResult) return batchResult(args);
      return {
        decision: 'APPROVE', summary: 'batch review ran', findings: [], positives: [],
        stats: { files: 4, skipped: 0, batches: 2, failedBatches: 0, promptTokens: 10, completionTokens: 5 },
      };
    },
    prepareFiles() { return { files: [], skipped: [] }; },
    sortFindings: (f) => f,
  });
  stub('../lib/reportFile', { writeReport() { return { path: null }; } });
  stub('../lib/publish', { async publish() { return { inline: 0, summaryPosted: true }; } });
  stub('../lib/gitlab', {
    async getMergeRequestChanges() {
      return { title: 'x', author: { username: 'dev' }, diff_refs: { head_sha: 'h1' }, changes: [{ new_path: 'a.kt', diff: '@@ -1,0 +1,1 @@\n+x' }] };
    },
    async postNote() {},
  });
  delete require.cache[require.resolve('../lib/jobs')];
  return require('../lib/jobs');
}

async function runToCompletion(jobs, projectId, iid) {
  jobs.start({ projectId, mrIid: iid, post: false, trigger: 'manual' });
  for (let i = 0; i < 100 && jobs.get(projectId, iid).status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return jobs.get(projectId, iid);
}

test('a session-limited agent falls back to the next engine instead of returning checks only', async () => {
  let batchArgs = null;
  const jobs = setupJobs({ readyEngines: ['9router'], batchReviewSpy: (a) => { batchArgs = a; } });

  const job = await runToCompletion(jobs, 1, 1);

  assert.equal(job.status, 'done');
  assert.equal(job.reviewMode, 'batch', 'the review actually ran, on the other engine');
  assert.equal(job.fallbackEngine, '9router');
  assert.match(job.agentFallbackReason, /session limit/);
  assert.equal(batchArgs.provider, '9router', 'the batch call must not go back to the engine that just refused');
  assert.equal(job.summary, 'batch review ran');
  assert.ok(
    job.findings.some((f) => /ایجنت در دسترس نبود/.test(f.title)),
    'the report says the whole-project pass did not happen'
  );
});

test('with no other engine configured it stays honest instead of pretending a review happened', async () => {
  let batchCalled = false;
  const jobs = setupJobs({ readyEngines: [], batchReviewSpy: () => { batchCalled = true; } });

  const job = await runToCompletion(jobs, 2, 2);

  assert.equal(job.status, 'done');
  assert.equal(batchCalled, false, 'nothing to fall back to, so no second attempt');
  assert.equal(job.fallbackEngine, null);
  assert.ok(job.findings.some((f) => /هیچ موتوری نتوانست/.test(f.title)));
});

// "Ready" only means a key is on file. The local 9router proxy in particular
// is regularly down, so the first fallback answering with nothing but failed
// batches must not end the hunt — nor be reported as a review that happened.
test('an engine whose batches all fail is skipped for the next one', async () => {
  const tried = [];
  const jobs = setupJobs({
    readyEngines: ['9router', 'gemini'],
    batchReviewSpy: (a) => tried.push(a.provider),
    batchResult: (a) =>
      a.provider === '9router'
        ? { decision: 'REQUEST_CHANGES', summary: 'x', findings: [], positives: [],
            stats: { files: 4, skipped: 0, batches: 3, failedBatches: 3, promptTokens: 0, completionTokens: 0 } }
        : { decision: 'APPROVE', summary: 'batch review ran', findings: [], positives: [],
            stats: { files: 4, skipped: 0, batches: 3, failedBatches: 0, promptTokens: 10, completionTokens: 5 } },
  });

  const job = await runToCompletion(jobs, 3, 3);

  assert.deepEqual(tried, ['9router', 'gemini'], 'the dead proxy is not where it stops');
  assert.equal(job.fallbackEngine, 'gemini');
  assert.equal(job.summary, 'batch review ran');
  const note = job.findings.find((f) => /ایجنت در دسترس نبود/.test(f.title)).note;
  assert.match(note, /9router/, 'the report names the engine that failed on the way');
});

test('when every engine fails the report lists each attempt', async () => {
  const jobs = setupJobs({
    readyEngines: ['9router', 'gemini'],
    batchReviewSpy: () => {},
    batchResult: () => ({
      decision: 'REQUEST_CHANGES', summary: 'x', findings: [], positives: [],
      stats: { files: 4, skipped: 0, batches: 3, failedBatches: 3, promptTokens: 0, completionTokens: 0 },
    }),
  });

  const job = await runToCompletion(jobs, 4, 4);

  assert.equal(job.fallbackEngine, null);
  const finding = job.findings.find((f) => /هیچ موتوری نتوانست/.test(f.title));
  assert.ok(finding, 'no engine ran, and the report says so');
  assert.match(finding.note, /session limit/, 'why the agent itself refused');
  assert.match(finding.note, /9router/);
  assert.match(finding.note, /gemini/);
});
