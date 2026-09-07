// lib/devAnalytics.js: round-trip detection, the "deleted branch" edge case
// (GitLab answers 200+[] for a gone ref, not 404 — that must NOT read as
// "one tidy author"), the per-MR cap, and month grouping.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// devAnalytics.js does `const gitlab = require('./gitlab')` at module load
// time, so once it's cached it keeps whichever gitlab stub was active at
// that moment — re-stubbing gitlab.js for a later test would silently do
// nothing unless devAnalytics.js's own cache entry is dropped too.
function freshAnalytics() {
  delete require.cache[require.resolve('../lib/devAnalytics')];
  return require('../lib/devAnalytics');
}

function mr(overrides) {
  return {
    iid: 1, project_id: 9, title: 'Feature-EM-100-x', state: 'merged',
    source_branch: 'Feature-EM-100-x', target_branch: 'develop',
    created_at: '2026-03-05T10:00:00Z', merged_at: '2026-03-06T10:00:00Z',
    web_url: 'https://example/mr/1',
    ...overrides,
  };
}

test('a branch with one committer is not a round trip', async () => {
  stub('../lib/gitlab', {
    async listAuthorMergeRequests() { return [mr({ iid: 1, source_branch: 'b1' })]; },
    async listBranchAuthors(projectId, branch) { return [{ email: 'a@x.com', name: 'A' }]; },
  });
  const { buildDeveloperAnalytics } = freshAnalytics();
  const result = await buildDeveloperAnalytics('a_dev');
  assert.equal(result.months[0].tasks[0].roundTrip, false);
  assert.equal(result.roundTripMRs, 0);
});

test('two or more committers on the branch is a round trip', async () => {
  stub('../lib/gitlab', {
    async listAuthorMergeRequests() { return [mr({ iid: 2, source_branch: 'b2' })]; },
    async listBranchAuthors() { return [{ email: 'a@x.com', name: 'A' }, { email: 'b@x.com', name: 'B' }]; },
  });
  const { buildDeveloperAnalytics } = freshAnalytics();
  const result = await buildDeveloperAnalytics('a_dev');
  assert.equal(result.months[0].tasks[0].roundTrip, true);
  assert.equal(result.roundTripMRs, 1);
});

test('a deleted branch (GitLab returns 200+[]) counts as unknown, never "not a round trip"', async () => {
  stub('../lib/gitlab', {
    async listAuthorMergeRequests() { return [mr({ iid: 3, source_branch: 'gone' })]; },
    async listBranchAuthors() { return []; }, // what GitLab actually returns for a missing ref
  });
  const { buildDeveloperAnalytics } = freshAnalytics();
  const result = await buildDeveloperAnalytics('a_dev');
  const task = result.months[0].tasks[0];
  assert.equal(task.roundTrip, null, 'zero commits found must not be reported as a clean single-author branch');
  assert.equal(task.branchAuthorCount, null);
  assert.equal(result.roundTripMRs, 0);
  assert.equal(result.uncheckedMRs, 1);
});

test('a GitLab error fetching branch authors also counts as unknown, not a crash', async () => {
  stub('../lib/gitlab', {
    async listAuthorMergeRequests() { return [mr({ iid: 4, source_branch: 'errbranch' })]; },
    async listBranchAuthors() { throw new Error('GitLab API 500'); },
  });
  const { buildDeveloperAnalytics } = freshAnalytics();
  const result = await buildDeveloperAnalytics('a_dev');
  assert.equal(result.months[0].tasks[0].roundTrip, null);
  assert.equal(result.uncheckedMRs, 1);
});

test('MRs beyond the branch-check cap are counted but left unchecked, never falsely "clean"', async () => {
  const { MAX_MRS_FOR_BRANCH_CHECK } = require('../lib/devAnalytics');
  const many = Array.from({ length: MAX_MRS_FOR_BRANCH_CHECK + 5 }, (_, i) => mr({ iid: i + 1, source_branch: 'b' + i, created_at: '2026-01-01T00:00:00Z' }));
  let branchCalls = 0;
  stub('../lib/gitlab', {
    async listAuthorMergeRequests() { return many; },
    async listBranchAuthors() { branchCalls++; return [{ email: 'a@x.com', name: 'A' }]; },
  });
  const { buildDeveloperAnalytics } = freshAnalytics();
  const result = await buildDeveloperAnalytics('a_dev');
  assert.equal(result.totalMRs, MAX_MRS_FOR_BRANCH_CHECK + 5);
  assert.equal(branchCalls, MAX_MRS_FOR_BRANCH_CHECK, 'only the capped number of MRs get the extra API call');
  assert.equal(result.uncheckedMRs, 5, 'the ones beyond the cap are unknown, not assumed clean');
});

test('records group into calendar months and each keeps its task token', async () => {
  stub('../lib/gitlab', {
    async listAuthorMergeRequests() {
      return [
        mr({ iid: 5, source_branch: 'Feature-EM-1-a', title: 'Feature-EM-1-a', created_at: '2026-01-15T00:00:00Z' }),
        mr({ iid: 6, source_branch: 'Feature-EM-2-b', title: 'Feature-EM-2-b', created_at: '2026-01-20T00:00:00Z' }),
        mr({ iid: 7, source_branch: 'Feature-EM-3-c', title: 'Feature-EM-3-c', created_at: '2026-02-01T00:00:00Z' }),
      ];
    },
    async listBranchAuthors() { return [{ email: 'a@x.com', name: 'A' }]; },
  });
  const { buildDeveloperAnalytics } = freshAnalytics();
  const result = await buildDeveloperAnalytics('a_dev');
  assert.deepEqual(result.months.map((m) => m.month), ['2026-01', '2026-02']);
  assert.equal(result.months[0].mrCount, 2);
  assert.equal(result.months[1].mrCount, 1);
  assert.equal(result.months[0].tasks[0].task, 'EM-1');
  assert.equal(result.months[0].tasks[1].task, 'EM-2');
});
