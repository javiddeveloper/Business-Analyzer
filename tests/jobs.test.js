// Regression tests for the review job registry — the piece the dashboard's
// per-MR tabs depend on. Zero test dependencies (node:test only), same as
// business-generator's suite.
//
// gitlab/reviewer are stubbed through require.cache so nothing here touches a
// real GitLab or spends money on a model call.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.CR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-test-'));

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const posted = [];
let releaseDiff;
const diffGate = new Promise((resolve) => { releaseDiff = resolve; });

stub('../lib/gitlab', {
  async getMergeRequestChanges(projectId, mrIid) {
    // Hold every run open until the test releases the gate, so "are two MRs
    // actually in flight at the same time" is observable rather than a race.
    await diffGate;
    return {
      title: `MR ${mrIid}`,
      description: '',
      diff_refs: { head_sha: 'sha-' + mrIid },
      changes: [{ old_path: 'a.kt', new_path: 'a.kt', diff: '+ line' }],
    };
  },
  async postNote(projectId, mrIid, body) {
    posted.push({ projectId, mrIid, body });
  },
});

stub('../lib/reviewer', {
  async review({ mr }) {
    return { note: 'review of ' + mr.title, decision: 'APPROVE' };
  },
});

const jobs = require('../lib/jobs');

test('different MRs review in parallel; the same MR does not start twice', async () => {
  const a = jobs.start({ projectId: 7, mrIid: 1, post: true });
  const b = jobs.start({ projectId: 7, mrIid: 2, post: true });
  const aAgain = jobs.start({ projectId: 7, mrIid: 1, post: true });

  assert.equal(a.status, 'running');
  assert.equal(b.status, 'running');
  // Same MR while one is in flight → the existing job, not a second run.
  assert.strictEqual(aAgain, a, 'a second run for the same MR must be refused');
  assert.equal(jobs.list().length, 2, 'two MRs are tracked independently');

  releaseDiff();
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(jobs.get(7, 1).status, 'done');
  assert.equal(jobs.get(7, 2).status, 'done');
  assert.equal(jobs.get(7, 1).decision, 'APPROVE');
  assert.equal(jobs.get(7, 1).note, 'review of MR 1');
  assert.equal(jobs.get(7, 2).note, 'review of MR 2');
  assert.equal(posted.length, 2, 'each MR got exactly one comment');
  assert.ok(jobs.get(7, 1).posted && jobs.get(7, 2).posted);
});

test('a finished MR can be reviewed again, and postExisting republishes its note', async () => {
  const rerun = jobs.start({ projectId: 7, mrIid: 1, post: false });
  assert.equal(rerun.status, 'running', 'a completed job must not block a new run');
  await new Promise((r) => setTimeout(r, 50));

  const job = jobs.get(7, 1);
  assert.equal(job.status, 'done');
  assert.equal(job.posted, false, 'post:false must not comment on the MR');

  const before = posted.length;
  await jobs.postExisting(7, 1);
  assert.equal(posted.length, before + 1);
  assert.equal(jobs.get(7, 1).posted, true);
});

test('postExisting fails loudly when there is no review to post', async () => {
  await assert.rejects(() => jobs.postExisting(99, 99), /no review result/);
});
