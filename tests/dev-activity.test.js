// Covers the "Developers" tab's data layer: task extraction from branch
// names, the activity/accuracy heuristic (activity.js), manual ratings
// (ratings.js), and that a finished review actually feeds the score.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.CR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-devact-'));

const { extractTask } = require('../lib/task');

test('extractTask reads the EM-<number> token out of a branch name or title', () => {
  assert.equal(extractTask('Feature-EM-2634-refactor-pagination'), 'EM-2634');
  assert.equal(extractTask('em-17-fix-thing'), 'EM-17');
  assert.equal(extractTask('random-branch-name'), null);
  assert.equal(extractTask(''), null);
  assert.equal(extractTask(undefined), null);
});

// ---- activity.js ------------------------------------------------------------

test('computeAutoScore has nothing to say before any review has run', () => {
  const activity = require('../lib/activity');
  const result = activity.computeAutoScore('nobody-yet');
  assert.equal(result.score, null);
  assert.equal(result.reviewCount, 0);
});

test('computeAutoScore rewards clean reviews and penalizes High findings', () => {
  const activity = require('../lib/activity');
  activity.recordReview({ author: { username: 'clean-dev' }, projectId: 1, mrIid: 1, decision: 'APPROVE', severityCounts: {}, filesReviewed: 3 });
  activity.recordReview({ author: { username: 'clean-dev' }, projectId: 1, mrIid: 2, decision: 'APPROVE', severityCounts: {}, filesReviewed: 2 });
  activity.recordReview({ author: { username: 'buggy-dev' }, projectId: 1, mrIid: 3, decision: 'REQUEST_CHANGES', severityCounts: { High: 2, Medium: 1 }, filesReviewed: 5 });

  const clean = activity.computeAutoScore('clean-dev');
  const buggy = activity.computeAutoScore('buggy-dev');
  assert.equal(clean.reviewCount, 2);
  assert.equal(clean.accuracyScore, 100, 'zero findings across every review = perfect accuracy');
  assert.ok(buggy.accuracyScore < clean.accuracyScore, 'more/higher-severity findings must score lower');
  assert.ok(buggy.score < clean.score);
});

test('recordEvent and eventsFor round-trip, and authorKey prefers username over name', () => {
  const activity = require('../lib/activity');
  activity.recordEvent({ author: { username: 'reza.d', name: 'Reza D' }, projectId: 5, mrIid: 9, branch: 'Feature-EM-1-x', targetBranch: 'develop', task: 'EM-1', action: 'update' });
  const events = activity.eventsFor({ username: 'reza.d' });
  assert.equal(events.length, 1);
  assert.equal(events[0].author, 'reza.d');
  assert.equal(events[0].task, 'EM-1');
  assert.equal(activity.authorKey({ username: 'x', name: 'y' }), 'x');
  assert.equal(activity.authorKey({ name: 'y' }), 'y');
});

// ---- ratings.js ---------------------------------------------------------------

test('ratings.set clamps to 1-5, keeps unspecified params, and overall() averages onto a 20-100 scale', () => {
  const ratings = require('../lib/ratings');
  assert.equal(ratings.get('new-dev'), null);

  ratings.set('new-dev', { quality: 5, speed: 5 }, 'شروع خوبی داشته');
  let r = ratings.get('new-dev');
  assert.equal(r.scores.quality, 5);
  assert.equal(r.scores.speed, 5);
  assert.equal(r.scores.communication, null, 'params never set stay null, not a fabricated default');
  assert.equal(ratings.overall(r), 100);

  // Partial update must not wipe the params set earlier.
  ratings.set('new-dev', { quality: 1 });
  r = ratings.get('new-dev');
  assert.equal(r.scores.quality, 1);
  assert.equal(r.scores.speed, 5, 'an unrelated update does not reset a previously-set param');

  ratings.set('new-dev', { speed: 99 }); // out of range
  assert.equal(ratings.get('new-dev').scores.speed, 5, 'out-of-range values are clamped, not stored as-is');
});

// ---- jobs.js wiring -------------------------------------------------------------

test('a completed review records itself into the developer activity history', async () => {
  function stub(modulePath, exports) {
    const resolved = require.resolve(modulePath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
  }
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-devact-project-'));

  stub('../lib/ai_bridge', { secret: (k) => (k === 'PROJECT_PATH' ? projectPath : '') });
  stub('../lib/localRepo', { async loadContext() { return { fileContents: {}, warning: null }; } });
  stub('../lib/reportFile', { writeReport() { return { path: null }; } });
  stub('../lib/publish', { async publish() { return { inline: 0, summaryPosted: true }; } });
  stub('../lib/gitlab', {
    async getMergeRequestChanges() {
      return { title: 'x', author: { username: 'tracked-dev' }, diff_refs: { head_sha: 'h1' }, changes: [] };
    },
    async postNote() {},
  });
  stub('../lib/reviewer', {
    async review() { return { decision: 'REQUEST_CHANGES', summary: 's', findings: [{ severity: 'High' }, { severity: 'Low' }], positives: [], stats: { files: 0, skipped: 0, promptTokens: 0, completionTokens: 0 } }; },
    prepareFiles() { return { files: [], skipped: [] }; },
    sortFindings: (f) => f,
  });

  const jobs = require('../lib/jobs');
  const activity = require('../lib/activity');

  jobs.start({ projectId: 77, mrIid: 1, post: false, trigger: 'manual' });
  for (let i = 0; i < 50 && jobs.get(77, 1).status === 'running'; i++) await new Promise((r) => setTimeout(r, 10));

  const reviews = activity.reviewsFor('tracked-dev');
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].decision, 'REQUEST_CHANGES');
  assert.deepEqual(reviews[0].severityCounts, { High: 1, Low: 1 });
});
