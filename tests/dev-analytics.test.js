// lib/devAnalytics.js: round-trip must mean "someone other than the MR's own
// author committed to it" — not just "more than one distinct git identity",
// since the same person routinely commits under two emails/name spellings
// (verified against real history: work email + personal gmail, English
// username + Persian display name for the same account). Also covers the
// per-MR cap, month grouping, and the rule that round-trip is only ever
// computed for an MR coder-review actually reviewed (review/MR-<iid>.md on
// disk) — never inferred from raw commit history alone.
const test = require('node:test');
const assert = require('node:assert');

// Members are read once per analytics build; tests set them through this so
// each gitlab stub does not have to repeat the plumbing.
const STUB_MEMBERS = { value: [] };

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  if (modulePath.endsWith('/gitlab') && !exports.listProjectMembers) {
    exports = { ...exports, async listProjectMembers() { return STUB_MEMBERS.value; } };
  }
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// devAnalytics.js does `const gitlab = require('./gitlab')` (and now also
// `./projects`, `./reportFile`) at module load time, so once it's cached it
// keeps whichever stubs were active at that moment — re-stubbing for a later
// test would silently do nothing unless devAnalytics.js's own cache entry is
// dropped too.
function freshAnalytics() {
  delete require.cache[require.resolve('../lib/devAnalytics')];
  return require('../lib/devAnalytics');
}

const AUTHOR = { username: 'a_dev', name: 'A Dev' };
const PROJECT_PATH = 'Z:\\fake-project';

// Every test in this file wants "there is a review report for this MR" to
// be the norm (that's the precondition under test elsewhere) — a fake
// project path plus a reportFile.reportPath/fs.existsSync pair that always
// says yes, unless a specific test swaps existsSync out.
// "There is a review report for this MR" now means the stronger thing the
// team asked for: the file is on disk *and* a maintainer added it to git.
// Tests that want a normal reviewed MR get both halves from here; the ones
// about the rule itself override a half deliberately.
const MAINTAINER = { username: 'boss', name: 'The Boss', access_level: 40 };
const DEVELOPER_MEMBER = { username: 'a_dev', name: 'A Dev', access_level: 30 };

function stubSignoff({ addedBy = { name: 'boss', email: 'boss@work.com' }, members = [MAINTAINER, DEVELOPER_MEMBER], iids = null } = {}) {
  const real = require('../lib/reviewSignoff');
  // `iids: null` (the default) means every MR is signed off, so tests that
  // are about something else do not have to enumerate their merge requests.
  // Pass an explicit list — including [] — to test the rule itself.
  const signoffs = iids === null
    ? { get: () => addedBy }                       // Map-shaped enough for signoffFor
    : new Map(iids.map((iid) => [iid, addedBy]));
  // Only loadSignoffs is faked — it is the one part that shells out to git.
  // The matching and verdict logic stays real, because that is the part with
  // the rule in it.
  stub('../lib/reviewSignoff', { ...real, loadSignoffs: async () => signoffs });
  return members;
}

function stubReportsExist(signoffOpts) {
  const members = stubSignoff(signoffOpts);
  stub('../lib/projects', { listProjects: () => [{ id: 9, name: 'Test Project', path: PROJECT_PATH }], getProjectPath: () => PROJECT_PATH });
  stub('../lib/reportFile', { reportPath: (p, iid) => `${p}/review/MR-${iid}.md` });
  STUB_MEMBERS.value = members;
  // The path above is fake — nothing is really on disk at PROJECT_PATH — so
  // fs.existsSync itself has to be told "yes" for every test in this file
  // that means to simulate an already-reviewed MR. Safe to leave patched:
  // node's test runner gives each test *file* its own process.
  require('fs').existsSync = () => true;
}

function mr(overrides) {
  return {
    iid: 1, project_id: 9, title: 'Feature-EM-100-x', state: 'merged',
    source_branch: 'Feature-EM-100-x', target_branch: 'develop',
    created_at: '2026-03-05T10:00:00Z', merged_at: '2026-03-06T10:00:00Z',
    web_url: 'https://example/mr/1', author: AUTHOR,
    ...overrides,
  };
}

// devAnalytics reads commits through getMergeRequestCommitStats, which returns
// counts and dates alongside the authors (one call serving round-trip, cycle
// time and rework alike). These stubs shape a plausible response from a plain
// list of authors, so each test still says only what it is about.
function commitStats(authors, extra = {}) {
  const times = extra.times || [];
  return {
    total: extra.total != null ? extra.total : authors.length,
    byAuthor: authors.map((a) => ({ ...a, count: 1 })),
    firstAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
    lastAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
    times,
  };
}


test('only the MR author\'s own commits (even under a different email) is not a round trip', async () => {
  stubReportsExist();
  stub('../lib/gitlab', {
    async listAuthorMergeRequests() { return [mr({ iid: 1 })]; },
    // Same person, two real-world identities: username-matching work email,
    // and a personal-name-matching email with a different address entirely.
    async getMergeRequestCommitStats() {
      return commitStats([{ email: 'a_dev@work.com', name: 'a_dev' }, { email: 'personal@gmail.com', name: 'A Dev' }]);
    },
  });
  const { buildDeveloperAnalytics } = freshAnalytics();
  const result = await buildDeveloperAnalytics('a_dev');
  assert.equal(result.months[0].tasks[0].roundTrip, false);
  assert.equal(result.roundTripMRs, 0);
});

test('a commit from someone who is neither the username nor the display name is a round trip', async () => {
  stubReportsExist();
  stub('../lib/gitlab', {
    async listAuthorMergeRequests() { return [mr({ iid: 2 })]; },
    async getMergeRequestCommitStats() {
      return commitStats([{ email: 'a_dev@work.com', name: 'a_dev' }, { email: 'other@work.com', name: 'Other Person' }]);
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
  stubReportsExist();
  stub('../lib/gitlab', {
    async listAuthorMergeRequests() { return [mr({ iid: 3 })]; },
    async getMergeRequestCommitStats() { return commitStats([]); }, // API oddity — must not be trusted as "clean"
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
  stubReportsExist();
  stub('../lib/gitlab', {
    async listAuthorMergeRequests() { return [mr({ iid: 4 })]; },
    async getMergeRequestCommitStats() { throw new Error('GitLab API 500'); },
  });
  const { buildDeveloperAnalytics } = freshAnalytics();
  const result = await buildDeveloperAnalytics('a_dev');
  assert.equal(result.months[0].tasks[0].roundTrip, null);
  assert.equal(result.uncheckedMRs, 1);
});

test('an MR with no review report gets no round-trip verdict, and costs no extra API call', async () => {
  stub('../lib/projects', { listProjects: () => [{ id: 9, name: 'Test Project', path: PROJECT_PATH }], getProjectPath: () => PROJECT_PATH });
  stub('../lib/reportFile', { reportPath: (p, iid) => `${p}/review/MR-${iid}.md` }); // path exists, but...
  const fs = require('fs');
  const originalExistsSync = fs.existsSync;
  fs.existsSync = () => false; // ...never on disk, i.e. coder-review never reviewed it
  let calls = 0;
  stub('../lib/gitlab', {
    async listAuthorMergeRequests() { return [mr({ iid: 8 })]; },
    async getMergeRequestCommitStats() { calls++; return commitStats([{ email: 'other@work.com', name: 'Other Person' }]); },
  });
  try {
    const { buildDeveloperAnalytics } = freshAnalytics();
    const result = await buildDeveloperAnalytics('a_dev');
    const rec = result.months[0].tasks[0];
    assert.equal(rec.hasReport, false);
    assert.equal(rec.roundTrip, null, 'no report — no round-trip claim, even though the commit history alone would look like one');
    assert.equal(calls, 0, 'never worth the extra GitLab call for an MR we have no report for');
    assert.equal(result.roundTripMRs, 0);
    assert.equal(result.uncheckedMRs, 0, '"unknown" is reserved for MRs we did review but couldn\'t verify — this one was never in scope at all');
    assert.equal(result.reportedMRs, 0);
  } finally {
    fs.existsSync = originalExistsSync;
  }
});

test('MRs beyond the per-request cap are counted but left unchecked, never falsely "clean"', async () => {
  stubReportsExist();
  const { MAX_MRS_FOR_BRANCH_CHECK } = require('../lib/devAnalytics');
  const many = Array.from({ length: MAX_MRS_FOR_BRANCH_CHECK + 5 }, (_, i) => mr({ iid: i + 1, created_at: '2026-01-01T00:00:00Z' }));
  let calls = 0;
  stub('../lib/gitlab', {
    async listAuthorMergeRequests() { return many; },
    async getMergeRequestCommitStats() { calls++; return commitStats([{ email: 'a_dev@work.com', name: 'a_dev' }]); },
  });
  const { buildDeveloperAnalytics } = freshAnalytics();
  const result = await buildDeveloperAnalytics('a_dev');
  assert.equal(result.totalMRs, MAX_MRS_FOR_BRANCH_CHECK + 5);
  assert.equal(calls, MAX_MRS_FOR_BRANCH_CHECK, 'only the capped number of MRs get the extra API call');
  assert.equal(result.uncheckedMRs, 5, 'the ones beyond the cap are unknown, not assumed clean');
});

test('records group into calendar months, newest month first, each keeping its task token', async () => {
  stubReportsExist();
  stub('../lib/gitlab', {
    async listAuthorMergeRequests() {
      return [
        mr({ iid: 5, source_branch: 'Feature-EM-1-a', title: 'Feature-EM-1-a', created_at: '2026-01-15T00:00:00Z' }),
        mr({ iid: 6, source_branch: 'Feature-EM-2-b', title: 'Feature-EM-2-b', created_at: '2026-01-20T00:00:00Z' }),
        mr({ iid: 7, source_branch: 'Feature-EM-3-c', title: 'Feature-EM-3-c', created_at: '2026-02-01T00:00:00Z' }),
      ];
    },
    async getMergeRequestCommitStats() { return commitStats([{ email: 'a_dev@work.com', name: 'a_dev' }]); },
  });
  const { buildDeveloperAnalytics } = freshAnalytics();
  const result = await buildDeveloperAnalytics('a_dev');
  assert.deepEqual(result.months.map((m) => m.month), ['2026-02', '2026-01'], 'newest month first');
  assert.equal(result.months[0].mrCount, 1);
  assert.equal(result.months[1].mrCount, 2);
  // Within the January bucket, newest-created MR (iid 6) still comes first.
  assert.equal(result.months[1].tasks[0].task, 'EM-2');
  assert.equal(result.months[1].tasks[1].task, 'EM-1');
});

test('isMrAuthor matches by username-as-email-local-part or exact display name', () => {
  const { isMrAuthor } = require('../lib/devAnalytics');
  const author = { username: 'r_derikvand', name: 'رضا دریکوند' };
  assert.equal(isMrAuthor(author, { author_email: 'r_derikvand@tamin.org', author_name: 'r_derikvand' }), true);
  assert.equal(isMrAuthor(author, { author_email: 'r_derikvand@tamin.org', author_name: 'Reza Derikvand' }), true, 'username-matching email is enough on its own');
  assert.equal(isMrAuthor(author, { author_email: 'someone@else.com', author_name: 'رضا دریکوند' }), true, 'exact display-name match is enough on its own');
  assert.equal(isMrAuthor(author, { author_email: 'j_sattar@tamin.org', author_name: 'جاوید ستار' }), false);
});

// ---- the sign-off rule ------------------------------------------------------
// A round trip is a negative mark, so the team's rule is that it only counts
// once a maintainer has added review/MR-<iid>.md — and stops the moment that
// file goes away. Without this, the tool writing its own report was enough to
// create a penalty, which made the penalty a by-product of running the tool
// rather than a judgement anyone made.

test('a maintainer-signed report makes the round trip count', async () => {
  stubReportsExist();
  stub('../lib/gitlab', {
    async listAuthorMergeRequests() { return [mr({ iid: 1 })]; },
    async getMergeRequestCommitStats() {
      return commitStats([{ email: 'a_dev@work.com', name: 'a_dev' }, { email: 'other@work.com', name: 'Other' }]);
    },
  });
  const result = await freshAnalytics().buildDeveloperAnalytics('a_dev');
  const rec = result.months[0].tasks[0];
  assert.equal(rec.roundTrip, true);
  assert.equal(rec.signoff.reason, 'signed-off');
  assert.equal(result.roundTripMRs, 1);
});

test('deleting the report file stops the round trip counting', async () => {
  stubReportsExist();
  require('fs').existsSync = () => false; // the file is gone
  stub('../lib/gitlab', {
    async listAuthorMergeRequests() { return [mr({ iid: 1 })]; },
    async getMergeRequestCommitStats() {
      throw new Error('must not be asked — an unsigned MR is not worth a commits lookup');
    },
  });
  const result = await freshAnalytics().buildDeveloperAnalytics('a_dev');
  const rec = result.months[0].tasks[0];
  assert.equal(rec.roundTrip, null, 'no verdict at all, not a clean one');
  assert.equal(rec.signoff.reason, 'no-file');
  assert.equal(result.roundTripMRs, 0);
  require('fs').existsSync = () => true;
});

test('a report the tool wrote but nobody committed does not count', async () => {
  stubReportsExist({ iids: [] }); // on disk, absent from git history
  stub('../lib/gitlab', {
    async listAuthorMergeRequests() { return [mr({ iid: 1 })]; },
    async getMergeRequestCommitStats() { throw new Error('must not be asked'); },
  });
  const result = await freshAnalytics().buildDeveloperAnalytics('a_dev');
  assert.equal(result.months[0].tasks[0].signoff.reason, 'not-committed');
  assert.equal(result.roundTripMRs, 0);
});

test('a report added by someone who is not a maintainer does not count', async () => {
  stubReportsExist({ addedBy: { name: 'a_dev', email: 'a_dev@work.com' } }); // a Developer
  stub('../lib/gitlab', {
    async listAuthorMergeRequests() { return [mr({ iid: 1 })]; },
    async getMergeRequestCommitStats() { throw new Error('must not be asked'); },
  });
  const result = await freshAnalytics().buildDeveloperAnalytics('a_dev');
  const rec = result.months[0].tasks[0];
  assert.equal(rec.signoff.reason, 'not-maintainer');
  assert.equal(rec.signoff.by, 'a_dev', 'and it says who, so this can be argued with');
  assert.equal(result.roundTripMRs, 0);
});

// Regression: sign-offs were read with a plain `git log`, which walks only the
// current branch. A maintainer commits the review file on the branch of the MR
// being reviewed, and this checkout is usually sitting somewhere else
// entirely, so legitimate sign-offs vanished depending on what happened to be
// checked out. Verified against the real repo: review/MR-191.md is committed
// on another branch and was being reported as never committed.
test('sign-offs are read across all branches, not just the checked-out one', () => {
  const real = require('../lib/reviewSignoff');
  // The exported source of truth is the argument list handed to git; assert on
  // it rather than on a live repo, which no test should need.
  const src = require('fs').readFileSync(require.resolve('../lib/reviewSignoff'), 'utf8');
  // --all is the guarantee this regression is about. The diff filter is
  // asserted separately below, because it carries a different guarantee and
  // pinning both in one pattern made this test fail for the right change.
  assert.match(src, /'log', '--all',/, 'the log must span every branch');
  assert.equal(typeof real.loadSignoffs, 'function');
});

// Regression: the scan used --diff-filter=A, so it only ever saw the commit
// that *created* review/MR-<iid>.md. The documented review process updates
// that same file each round and rewrites the trailing C/L rating every time,
// so any rating added in round 2 or later was invisible to the scorer. On the
// real repository that hid 3 of the 12 reports carrying a rating, and for one
// developer it hid their only rated MR — which made the whole mrSize
// component vanish from their score with no explanation on screen.
test('the rating scan sees later rounds, not just the commit that added the file', () => {
  const src = require('fs').readFileSync(require.resolve('../lib/reviewSignoff'), 'utf8');
  assert.match(src, /'--diff-filter=AM'/, 'modifications must be walked, not only additions');

  const analytics = require('fs').readFileSync(require.resolve('../lib/devAnalytics'), 'utf8');
  // The body must come from the newest revision...
  assert.match(analytics, /added\.latest \|\| added/, 'the rating must be read from the newest revision');
  // ...but only when that revision is itself maintainer-authored, or a
  // developer could rate their own merge request by editing the report after
  // a maintainer created it.
  assert.match(analytics, /isMaintainerAuthor\(newest, ctx\.maintainers\)/,
    'the newest revision only counts when a maintainer wrote it');
});
