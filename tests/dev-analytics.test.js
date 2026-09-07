// lib/devAnalytics.js: round-trip must mean "someone other than the MR's own
// author committed to it" — not just "more than one distinct git identity",
// since the same person routinely commits under two emails/name spellings
// (verified against real history: work email + personal gmail, English
// username + Persian display name for the same account). Also covers the
// per-MR cap and month grouping.
const test = require('node:test');
const assert = require('node:assert');

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

const AUTHOR = { username: 'a_dev', name: 'A Dev' };

function mr(overrides) {
  return {
    iid: 1, project_id: 9, title: 'Feature-EM-100-x', state: 'merged',
    source_branch: 'Feature-EM-100-x', target_branch: 'develop',
    created_at: '2026-03-05T10:00:00Z', merged_at: '2026-03-06T10:00:00Z',
    web_url: 'https://example/mr/1', author: AUTHOR,
    ...overrides,
  };
}

test('only the MR author\'s own commits (even under a different email) is not a round trip', async () => {
  stub('../lib/gitlab', {
    async listAuthorMergeRequests() { return [mr({ iid: 1 })]; },
    // Same person, two real-world identities: username-matching work email,
    // and a personal-name-matching email with a different address entirely.
    async listMergeRequestCommitAuthors() {
      return [{ email: 'a_dev@work.com', name: 'a_dev' }, { email: 'personal@gmail.com', name: 'A Dev' }];
    },
  });
  const { buildDeveloperAnalytics } = freshAnalytics();
  const result = await buildDeveloperAnalytics('a_dev');
  assert.equal(result.months[0].tasks[0].roundTrip, false);
  assert.equal(result.roundTripMRs, 0);
});

test('a commit from someone who is neither the username nor the display name is a round trip', async () => {
  stub('../lib/gitlab', {
    async listAuthorMergeRequests() { return [mr({ iid: 2 })]; },
    async listMergeRequestCommitAuthors() {
      return [{ email: 'a_dev@work.com', name: 'a_dev' }, { email: 'other@work.com', name: 'Other Person' }];
    },
  });
  const { buildDeveloperAnalytics } = freshAnalytics();
  const result = await buildDeveloperAnalytics('a_dev');
  const rec = result.months[0].tasks[0];
  assert.equal(rec.roundTrip, true);
  assert.deepEqual(rec.otherAuthors, ['Other Person']);
  assert.equal(result.roundTripMRs, 1);
});

test('zero commits returned counts as unknown, never "not a round trip"', async () => {
  stub('../lib/gitlab', {
    async listAuthorMergeRequests() { return [mr({ iid: 3 })]; },
    async listMergeRequestCommitAuthors() { return []; }, // API oddity — must not be trusted as "clean"
  });
  const { buildDeveloperAnalytics } = freshAnalytics();
  const result = await buildDeveloperAnalytics('a_dev');
  const rec = result.months[0].tasks[0];
  assert.equal(rec.roundTrip, null);
  assert.equal(rec.commitAuthorCount, null);
  assert.equal(result.roundTripMRs, 0);
  assert.equal(result.uncheckedMRs, 1);
});

test('a GitLab error fetching MR commits also counts as unknown, not a crash', async () => {
  stub('../lib/gitlab', {
    async listAuthorMergeRequests() { return [mr({ iid: 4 })]; },
    async listMergeRequestCommitAuthors() { throw new Error('GitLab API 500'); },
  });
  const { buildDeveloperAnalytics } = freshAnalytics();
  const result = await buildDeveloperAnalytics('a_dev');
  assert.equal(result.months[0].tasks[0].roundTrip, null);
  assert.equal(result.uncheckedMRs, 1);
});

test('MRs beyond the per-request cap are counted but left unchecked, never falsely "clean"', async () => {
  const { MAX_MRS_FOR_BRANCH_CHECK } = require('../lib/devAnalytics');
  const many = Array.from({ length: MAX_MRS_FOR_BRANCH_CHECK + 5 }, (_, i) => mr({ iid: i + 1, created_at: '2026-01-01T00:00:00Z' }));
  let calls = 0;
  stub('../lib/gitlab', {
    async listAuthorMergeRequests() { return many; },
    async listMergeRequestCommitAuthors() { calls++; return [{ email: 'a_dev@work.com', name: 'a_dev' }]; },
  });
  const { buildDeveloperAnalytics } = freshAnalytics();
  const result = await buildDeveloperAnalytics('a_dev');
  assert.equal(result.totalMRs, MAX_MRS_FOR_BRANCH_CHECK + 5);
  assert.equal(calls, MAX_MRS_FOR_BRANCH_CHECK, 'only the capped number of MRs get the extra API call');
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
    async listMergeRequestCommitAuthors() { return [{ email: 'a_dev@work.com', name: 'a_dev' }]; },
  });
  const { buildDeveloperAnalytics } = freshAnalytics();
  const result = await buildDeveloperAnalytics('a_dev');
  assert.deepEqual(result.months.map((m) => m.month), ['2026-01', '2026-02']);
  assert.equal(result.months[0].mrCount, 2);
  assert.equal(result.months[1].mrCount, 1);
  assert.equal(result.months[0].tasks[0].task, 'EM-1');
  assert.equal(result.months[0].tasks[1].task, 'EM-2');
});

test('isMrAuthor matches by username-as-email-local-part or exact display name', () => {
  const { isMrAuthor } = require('../lib/devAnalytics');
  const author = { username: 'r_derikvand', name: 'رضا دریکوند' };
  assert.equal(isMrAuthor(author, { author_email: 'r_derikvand@tamin.org', author_name: 'r_derikvand' }), true);
  assert.equal(isMrAuthor(author, { author_email: 'r_derikvand@tamin.org', author_name: 'Reza Derikvand' }), true, 'username-matching email is enough on its own');
  assert.equal(isMrAuthor(author, { author_email: 'someone@else.com', author_name: 'رضا دریکوند' }), true, 'exact display-name match is enough on its own');
  assert.equal(isMrAuthor(author, { author_email: 'j_sattar@tamin.org', author_name: 'جاوید ستار' }), false);
});
