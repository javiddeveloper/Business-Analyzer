// Covers the three pieces added for local-project-aware review:
//  - envFile: masking secrets and rewriting secrets.env without clobbering it
//  - reportFile: the review/MR-<iid>.md shape
//  - localRepo: real git plumbing against an actual (throwaway) repo pair
//  - the merge-order gate in jobs.js (auto-approve must respect creation order)
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

process.env.CR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-lre-'));

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// ---- envFile ---------------------------------------------------------------

test('envFile masks secrets, leaves other keys untouched, and appends new ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-envfile-'));
  const secretsPath = path.join(dir, 'secrets.env');
  fs.writeFileSync(secretsPath, [
    '# a comment that must survive',
    'GITLAB_URL=https://gitlab.com',
    'GITLAB_TOKEN=glpat-realtoken1234',
    '',
    'AI_MODEL=gpt-4o-mini',
  ].join('\n'));

  const envFilePath = require.resolve('../lib/envFile');
  const aiBridgePath = require.resolve('../lib/ai_bridge');
  delete require.cache[envFilePath];
  delete require.cache[aiBridgePath];
  const originalCwdSecrets = fs.readFileSync(path.join(__dirname, '..', 'secrets.env'), 'utf8').catch
    ? null
    : null;

  // envFile/ai_bridge resolve secrets.env relative to lib/.. — point them at
  // our throwaway file instead of the project's real one by overriding the
  // module's resolved path via a fresh copy trick: simplest is to swap process
  // cwd-independent constant using a monkeypatched fs proxy is overkill here;
  // instead we just call describe()/writeValues() against the real project
  // secrets.env's directory by temporarily copying our fixture over it and
  // restoring it afterwards.
  const realSecretsPath = path.join(__dirname, '..', 'secrets.env');
  const hadReal = fs.existsSync(realSecretsPath);
  const backup = hadReal ? fs.readFileSync(realSecretsPath) : null;
  fs.copyFileSync(secretsPath, realSecretsPath);
  try {
    const envFile = require('../lib/envFile');
    const described = envFile.describe();
    const token = described.find((e) => e.key === 'GITLAB_TOKEN');
    assert.ok(token.value.endsWith('1234'), 'last 4 chars of a secret are visible');
    assert.ok(token.value.startsWith('•'), 'the rest is masked');
    assert.equal(token.set, true);

    const url = described.find((e) => e.key === 'GITLAB_URL');
    assert.equal(url.value, 'https://gitlab.com', 'non-secret values are shown in full');

    envFile.writeValues({ GITLAB_TOKEN: 'glpat-brandnew9999', PROJECT_PATH: '/repos/myapp' });
    const raw = fs.readFileSync(realSecretsPath, 'utf8');
    assert.match(raw, /# a comment that must survive/, 'untouched lines are preserved');
    assert.match(raw, /GITLAB_URL=https:\/\/gitlab\.com/, 'keys not being updated are untouched');
    assert.match(raw, /GITLAB_TOKEN=glpat-brandnew9999/, 'the updated key changed in place');
    assert.match(raw, /PROJECT_PATH=\/repos\/myapp/, 'a key with no prior line is appended');
    assert.ok(!raw.includes('GITLAB_TOKEN=glpat-realtoken1234'), 'the old secret value is gone, not just appended after');
  } finally {
    if (hadReal) fs.writeFileSync(realSecretsPath, backup);
    else fs.rmSync(realSecretsPath, { force: true });
  }
});

// ---- reportFile -------------------------------------------------------------

test('reportFile writes review/MR-<iid>.md with the expected sections', () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-report-'));
  const reportFile = require('../lib/reportFile');
  const result = {
    decision: 'REQUEST_CHANGES',
    summary: 'یک خلاصه‌ی آزمایشی.',
    positives: ['تست‌های خوبی اضافه شده'],
    findings: [
      { file: 'a.kt', line: 10, severity: 'High', category: 'logic', title: 'باگ فرضی', note: 'توضیح باگ', suggestion: 'val x = 1', source: 'model' },
    ],
    stats: { files: 1, skipped: 0 },
  };
  const mr = { source_branch: 'feature-x', target_branch: 'develop', web_url: 'https://example/mr/1', author: { name: 'کاربر' }, diff_refs: { head_sha: 'abc123456789' } };

  const written = reportFile.writeReport({ projectPath, mrIid: 42, mr, result });
  assert.ok(written.path.endsWith(path.join('review', 'MR-42.md')));
  const text = fs.readFileSync(written.path, 'utf8');
  assert.match(text, /# Code Review — MR !42/);
  assert.match(text, /feature-x → develop/);
  assert.match(text, /REQUEST_CHANGES/);
  assert.match(text, /باگ فرضی/);
  assert.match(text, /val x = 1/);
  assert.match(text, /تست‌های خوبی اضافه شده/);

  // Re-running overwrites rather than appending a second copy.
  reportFile.writeReport({ projectPath, mrIid: 42, mr, result: { ...result, summary: 'خلاصه‌ی دوم' } });
  const text2 = fs.readFileSync(written.path, 'utf8');
  assert.match(text2, /خلاصه‌ی دوم/);
  assert.equal((text2.match(/# Code Review/g) || []).length, 1);
});

// ---- localRepo ---------------------------------------------------------------

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

test('localRepo reads a file out of an MR ref without touching the checkout', async (t) => {
  let hasGit = true;
  try { execFileSync('git', ['--version']); } catch (e) { hasGit = false; }
  if (!hasGit) return t.skip('git not available in this environment');

  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-bare-'));
  git(bare, ['init', '--bare']);
  // Force HEAD to a known branch name regardless of this machine's git
  // default (init.defaultBranch varies) — otherwise `git clone` below can't
  // resolve HEAD and checks out nothing, which is what we actually hit here.
  git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-work-'));
  git(work, ['init']);
  git(work, ['config', 'user.email', 'a@b.c']);
  git(work, ['config', 'user.name', 'tester']);
  fs.writeFileSync(path.join(work, 'a.txt'), 'base content\n');
  git(work, ['add', 'a.txt']);
  git(work, ['commit', '-m', 'base']);
  git(work, ['remote', 'add', 'origin', bare]);
  git(work, ['push', 'origin', 'HEAD:refs/heads/main']);

  fs.writeFileSync(path.join(work, 'a.txt'), 'mr content\n');
  git(work, ['commit', '-am', 'mr change']);
  const headSha = git(work, ['rev-parse', 'HEAD']).trim();
  // Simulates what GitLab creates automatically for a real merge request.
  git(work, ['push', 'origin', `HEAD:refs/merge-requests/7/head`]);

  // The "reviewer's checkout" only has main — it must fetch the MR ref itself.
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-checkout-'));
  execFileSync('git', ['clone', bare, checkout], { encoding: 'utf8' });

  const localRepo = require('../lib/localRepo');
  const { fileContents, warning } = await localRepo.loadContext({
    projectPath: checkout,
    mrIid: 7,
    headSha,
    paths: ['a.txt', 'does-not-exist.txt'],
  });

  // Normalize CRLF: Windows git (core.autocrlf) may render checked-out/shown
  // text with \r\n regardless of what was typed above — irrelevant to what
  // this test is actually checking (which commit's content comes back).
  const norm = (s) => (s == null ? s : s.replace(/\r\n/g, '\n'));

  assert.equal(warning, null);
  assert.equal(norm(fileContents['a.txt']), 'mr content\n');
  assert.equal(fileContents['does-not-exist.txt'], undefined, 'a missing file is simply absent, not an error');

  // The checkout's own working tree must be untouched.
  assert.equal(norm(fs.readFileSync(path.join(checkout, 'a.txt'), 'utf8')), 'base content\n');
});

test('localRepo degrades to a warning instead of throwing on a bad path', async () => {
  const localRepo = require('../lib/localRepo');
  const missing = await localRepo.loadContext({ projectPath: path.join(os.tmpdir(), 'does-not-exist-' + Date.now()), mrIid: 1, headSha: 'x', paths: ['a'] });
  assert.match(missing.warning, /پیدا نشد/);

  const notGit = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-notgit-'));
  const result = await localRepo.loadContext({ projectPath: notGit, mrIid: 1, headSha: 'x', paths: ['a'] });
  assert.match(result.warning, /ریپازیتوری گیت نیست/);
});

// ---- merge-order gate on auto-approve ---------------------------------------

test('auto-approve is blocked while an earlier-created MR in the same project is still unapproved', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-order-'));
  const approvals = [];

  stub('../lib/ai_bridge', {
    secret: (k) => (k === 'PROJECT_PATH' ? projectPath : ''),
  });
  stub('../lib/localRepo', { async loadContext() { return { fileContents: {}, warning: null }; } });
  stub('../lib/reportFile', { writeReport() { return { path: null }; } });
  stub('../lib/reviewer', {
    async review() {
      return { decision: 'APPROVE', summary: 'clean', findings: [], positives: [], stats: { files: 1, skipped: 0, promptTokens: 0, completionTokens: 0 } };
    },
    prepareFiles() { return { files: [], skipped: [] }; },
    sortFindings: (f) => f,
  });
  stub('../lib/publish', { async publish() { return { inline: 0, summaryPosted: true }; } });
  stub('../lib/gitlab', {
    async getMergeRequestChanges(projectId, mrIid) {
      return {
        title: 'MR ' + mrIid,
        created_at: mrIid === 10 ? '2026-01-01T00:00:00Z' : '2026-01-02T00:00:00Z',
        diff_refs: { head_sha: 'sha-' + mrIid },
        changes: [],
      };
    },
    async postNote() {},
    async approveMergeRequest(projectId, mrIid) { approvals.push(mrIid); },
    async listOpenMergeRequests() {
      return [
        { project_id: 55, iid: 10, created_at: '2026-01-01T00:00:00Z' }, // older, not yet approved
        { project_id: 55, iid: 11, created_at: '2026-01-02T00:00:00Z' },
      ];
    },
  });

  const state = require('../lib/state');
  state.saveSettings({ autoApprove: true });

  const jobs = require('../lib/jobs');

  const blocked = jobs.start({ projectId: 55, mrIid: 11, post: true, trigger: 'manual' });
  for (let i = 0; i < 50 && jobs.get(55, 11).status === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(jobs.get(55, 11).status, 'done');
  assert.equal(jobs.get(55, 11).approved, false, 'the newer MR must not jump the queue');
  assert.match(jobs.get(55, 11).approveError, /ترتیب merge/);
  assert.equal(approvals.length, 0);

  // Now the older MR gets approved first — the newer one should go through.
  state.markApproved(jobs.keyFor(55, 10));
  const unblocked = jobs.start({ projectId: 55, mrIid: 11, post: true, trigger: 'manual' });
  for (let i = 0; i < 50 && jobs.get(55, 11).status === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(jobs.get(55, 11).approved, true);
  assert.deepEqual(approvals, [11]);
});
