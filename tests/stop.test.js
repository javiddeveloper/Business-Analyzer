// jobs.stop() must actually cancel a running review, not just flip a flag
// nobody reads — this exercises the AbortController wiring through
// reviewer.review down to the (stubbed) model call.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.CR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-stop-test-'));

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

let modelCalls = 0;
let sawAbortedSignal = false;

stub('../lib/gitlab', {
  async getMergeRequestChanges() {
    return {
      title: 'slow MR',
      diff_refs: { head_sha: 'sha1' },
      changes: [{ new_path: 'a.kt', diff: '@@ -1,0 +1,1 @@\n+x' }],
    };
  },
  async postNote() {},
  async createDiscussion() {},
  async listDiscussions() { return []; },
});

// A model call that hangs until aborted — the shape of the real flaky-proxy
// scenario that motivated the stop button in the first place.
stub('../lib/ai_bridge', {
  secret: () => '',
  callModel: ({ signal }) => new Promise((resolve, reject) => {
    modelCalls++;
    if (signal.aborted) { sawAbortedSignal = true; return reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }
    signal.addEventListener('abort', () => {
      sawAbortedSignal = true;
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  }),
});

const jobs = require('../lib/jobs');

test('stop() cancels a running review promptly', async () => {
  const job = jobs.start({ projectId: 1, mrIid: 1, post: false });
  assert.equal(job.status, 'running');
  await new Promise((r) => setTimeout(r, 10)); // let the model call actually start

  const stopped = jobs.stop(1, 1);
  assert.ok(stopped);

  for (let i = 0; i < 50 && jobs.get(1, 1).status === 'running'; i++) await new Promise((r) => setTimeout(r, 10));

  assert.equal(jobs.get(1, 1).status, 'stopped');
  assert.ok(sawAbortedSignal, 'the model call actually observed the abort');
  assert.ok(modelCalls >= 1);
});

test('stop() on an MR with nothing running reports false', () => {
  assert.equal(jobs.stop(1, 1), false, 'already finished — nothing to stop');
  assert.equal(jobs.stop(999, 999), false, 'never started — nothing to stop');
});
