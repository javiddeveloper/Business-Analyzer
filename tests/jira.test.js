// lib/jira.js powers the Developer Analytics task cards' Jira status/
// assignee badge (task.extractTask() already pulls a key like "EM-2600" out
// of a branch name — that key is the join to Jira). This covers: staying
// inert with no credentials, fetching one issue, and the bulk path used by
// the analytics endpoint — deduped, and tolerant of one bad key among many
// (branch names are free text; a placeholder like "EM-0000" is real history
// in this org and must not 404 the whole response).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.CR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-jira-'));

function stubSecrets(values) {
  delete require.cache[require.resolve('../lib/ai_bridge')];
  delete require.cache[require.resolve('../lib/jira')];
  const resolved = require.resolve('../lib/ai_bridge');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: { secret: (k) => values[k] || '' } };
  return require('../lib/jira');
}

// Self-hosted Jira (this org's jira.tamin.ir), authenticated with a
// Personal Access Token — no email/username field, unlike Jira Cloud's
// Basic Auth.
const CONFIGURED = { JIRA_BASE_URL: 'https://jira.tamin.ir', JIRA_API_TOKEN: 'tok' };

test('isConfigured is false until both Jira secrets are set', () => {
  const jira = stubSecrets({});
  assert.equal(jira.isConfigured(), false);
  assert.equal(stubSecrets({ JIRA_BASE_URL: 'https://jira.tamin.ir' }).isConfigured(), false, 'base url alone is not enough');
  assert.equal(stubSecrets(CONFIGURED).isConfigured(), true);
});

test('fetchIssue authenticates with a Bearer token, not Basic auth — this is self-hosted Jira, not Cloud', async () => {
  const jira = stubSecrets(CONFIGURED);
  const originalFetch = global.fetch;
  let seenAuth = null;
  global.fetch = async (url, opts) => {
    seenAuth = opts.headers.Authorization;
    return { ok: true, json: async () => ({ key: 'EM-1', fields: {} }) };
  };
  try {
    await jira.fetchIssue('EM-1');
    assert.equal(seenAuth, 'Bearer tok');
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetchIssue resolves to null (not a throw) when Jira is not configured', async () => {
  const jira = stubSecrets({});
  assert.equal(await jira.fetchIssue('EM-1'), null);
});

test('fetchIssuesByKeys makes no network calls at all when Jira is not configured', async () => {
  const jira = stubSecrets({});
  const originalFetch = global.fetch;
  global.fetch = () => { throw new Error('must not be called'); };
  try {
    const map = await jira.fetchIssuesByKeys(['EM-1', 'EM-2']);
    assert.equal(map.size, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetchIssuesByKeys dedupes repeated keys into one fetch, and maps status/assignee', async () => {
  const jira = stubSecrets(CONFIGURED);
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async (url) => {
    calls++;
    return {
      ok: true,
      json: async () => ({ key: 'EM-401', fields: { summary: 'x', status: { name: 'In Progress' }, assignee: { displayName: 'رضا' } } }),
    };
  };
  try {
    // A key unique to this test — lib/jira.js caches by key, and a value
    // reused across tests would make a later test see this test's response.
    const map = await jira.fetchIssuesByKeys(['EM-401', 'EM-401', 'EM-401']);
    assert.equal(calls, 1, 'the same key across several MRs is fetched once, not once per MR');
    assert.equal(map.get('EM-401').status, 'In Progress');
    assert.equal(map.get('EM-401').assignee, 'رضا');
  } finally {
    global.fetch = originalFetch;
  }
});

test('searchIssuesByAssignee reports Jira\'s own total, so a capped list is never shown as complete', async () => {
  const jira = stubSecrets(CONFIGURED);
  const originalFetch = global.fetch;
  let seenUrl = null;
  global.fetch = async (url) => {
    seenUrl = String(url);
    return {
      ok: true,
      json: async () => ({
        total: 340, // far more than the page of issues actually returned
        issues: [{ key: 'EM-9', fields: { summary: 's', status: { name: 'In Progress' }, updated: '2026-09-01T00:00:00.000+0330' } }],
      }),
    };
  };
  try {
    const { issues, total } = await jira.searchIssuesByAssignee('s_nami', { since: '2026-08-01' });
    assert.equal(issues.length, 1);
    assert.equal(total, 340, 'the caller can say "showing 1 of 340" instead of implying 1 is all there is');
    assert.equal(issues[0].status, 'In Progress');
    // URLSearchParams encodes spaces as "+", which decodeURIComponent leaves alone.
    const jql = decodeURIComponent(seenUrl).replace(/\+/g, ' ');
    assert.match(jql, /assignee = "s_nami"/);
    assert.match(jql, /updated >= "2026-08-01"/, 'the page\'s date filter reaches the JQL');
  } finally {
    global.fetch = originalFetch;
  }
});

// Regression: this function used to cache a bare array and now caches
// { issues, total }. A cache entry written by the older shape must not reach
// the caller as-is — it crashed the entire analytics page on `.issues.map`.
// (Namespace is bumped on every shape change; this test tracks the current
// one, since that is where a foreign-shaped entry could actually turn up.)
test('searchIssuesByAssignee normalizes a legacy-shaped cache entry instead of handing back something that crashes', async () => {
  const jira = stubSecrets(CONFIGURED);
  const cache = require('../lib/cache');
  // Write the pre-upgrade shape (a bare array) straight into the cache the
  // function reads, under the key it will look up.
  const legacy = [{ key: 'EM-7', summary: 'قدیمی', status: 'Done' }];
  await cache.cached(jira.SEARCH_CACHE, 'legacy_user|<|>', 60000, async () => legacy);

  const originalFetch = global.fetch;
  global.fetch = () => { throw new Error('should have been served from cache'); };
  try {
    const out = await jira.searchIssuesByAssignee('legacy_user', { since: '<', until: '>' });
    assert.ok(Array.isArray(out.issues), 'always { issues, total }, whatever the cache held');
    assert.equal(out.issues.length, 1);
    assert.equal(out.total, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

// Regression: the dashboard's 🔄 used to refresh only the GitLab half, so a
// ticket whose estimate had just been filled in still read as "no estimate"
// for up to 10 minutes — which looks like a developer who doesn't estimate,
// not like a stale cache.
test('force re-queries Jira instead of serving the cached page', async () => {
  const jira = stubSecrets(CONFIGURED);
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return { ok: true, json: async () => ({ total: 1, issues: [{ key: 'EM-77', fields: { summary: 's' } }] }) };
  };
  try {
    await jira.searchIssuesByAssignee('force_user');
    await jira.searchIssuesByAssignee('force_user');
    assert.equal(calls, 1, 'the second call is served from cache');
    await jira.searchIssuesByAssignee('force_user', { force: true });
    assert.equal(calls, 2, 'force goes back to Jira');
  } finally {
    global.fetch = originalFetch;
  }
});

test('searchIssuesByAssignee refuses a username that could break out of the JQL string', async () => {
  const jira = stubSecrets(CONFIGURED);
  const originalFetch = global.fetch;
  global.fetch = () => { throw new Error('must not be called'); };
  try {
    const bad = await jira.searchIssuesByAssignee('a" OR assignee != "x');
    assert.deepEqual(bad, { issues: [], total: 0 }, 'refused outright rather than escaped-and-hoped');
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetchIssuesByKeys tolerates one missing/erroring key without losing the others', async () => {
  const jira = stubSecrets(CONFIGURED);
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('EM-0000')) return { ok: false, status: 404 };
    return { ok: true, json: async () => ({ key: 'EM-501', fields: { summary: 'x', status: { name: 'Done' }, assignee: null } }) };
  };
  try {
    const map = await jira.fetchIssuesByKeys(['EM-501', 'EM-0000']);
    assert.equal(map.get('EM-501').status, 'Done');
    assert.equal(map.get('EM-0000'), null, 'a 404 becomes null, not a thrown error that would break the batch');
  } finally {
    global.fetch = originalFetch;
  }
});

// ---- worklogsByAuthor ------------------------------------------------------
// The source for weekly/monthly hours. The properties that matter: only this
// author's entries (a ticket's worklog holds everyone's), only entries on or
// after `since` (the JQL finds the issue, but its worklog is all-time), and
// one unreadable issue must not blank the whole week.
test('worklogsByAuthor keeps only this author\'s entries since the date, and survives one failing issue', async () => {
  const jira = stubSecrets(CONFIGURED);
  const originalFetch = global.fetch;
  const seen = [];
  global.fetch = async (url) => {
    seen.push(url);
    const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body });
    if (url.includes('/rest/api/2/search')) {
      return ok({ total: 3, issues: [{ key: 'EM-1' }, { key: 'EM-2' }, { key: 'EM-BROKEN' }] });
    }
    if (url.includes('EM-BROKEN')) return { ok: false, status: 500, text: async () => 'boom', json: async () => ({}) };
    if (url.includes('/issue/EM-1/worklog')) {
      return ok({ worklogs: [
        { author: { name: 's_nami' }, started: '2026-09-20T09:00:00.000+0330', timeSpentSeconds: 3600 * 3 },
        { author: { name: 'someone_else' }, started: '2026-09-20T09:00:00.000+0330', timeSpentSeconds: 3600 * 5 },
        { author: { name: 's_nami' }, started: '2026-01-02T09:00:00.000+0330', timeSpentSeconds: 3600 * 9 }, // before since
      ] });
    }
    if (url.includes('/issue/EM-2/worklog')) {
      return ok({ worklogs: [{ author: { name: 'S_NAMI' }, started: '2026-09-21T10:00:00.000+0330', timeSpentSeconds: 1800 }] });
    }
    throw new Error('unexpected ' + url);
  };
  try {
    const out = await jira.worklogsByAuthor('s_nami', { since: '2026-03-20' });
    assert.equal(out.entries.length, 2, 'the other author and the pre-`since` entry are both dropped');
    assert.deepEqual(out.entries.map((e) => e.seconds).sort((a, b) => a - b), [1800, 10800]);
    assert.equal(out.issueCount, 3);
    const jql = decodeURIComponent(seen.find((u) => u.includes('/search')));
    assert.match(jql, /worklogAuthor = "s_nami"/, 'found by who logged, not by assignee');
    assert.match(jql, /worklogDate >= "2026-03-20"/);
  } finally {
    global.fetch = originalFetch;
  }
});

// A complete inline worklog is used as-is (no per-issue call), a truncated
// one is read in full, and the search pages past its first 100 results.
test('worklogsByAuthor uses complete inline worklogs, refetches truncated ones, and pages the search', async () => {
  const jira = stubSecrets(CONFIGURED);
  const originalFetch = global.fetch;
  const worklogCalls = [];
  const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body });
  const inline = (n) => ({ total: n, worklogs: Array.from({ length: n }, () => (
    { author: { name: 'r_x' }, started: '2026-09-20T09:00:00.000+0330', timeSpentSeconds: 3600 }
  )) });
  global.fetch = async (url) => {
    if (url.includes('/rest/api/2/search')) {
      const startAt = Number(/startAt=(\d+)/.exec(url)[1]);
      if (startAt === 0) {
        const issues = Array.from({ length: 100 }, (_, i) => ({ key: 'EM-' + i, fields: { worklog: inline(1) } }));
        issues[5] = { key: 'EM-5', fields: { worklog: { total: 25, worklogs: inline(20).worklogs } } }; // truncated
        return ok({ total: 101, issues });
      }
      return ok({ total: 101, issues: [{ key: 'EM-100', fields: { worklog: inline(2) } }] });
    }
    if (url.includes('/worklog')) {
      worklogCalls.push(url);
      return ok(inline(25));
    }
    throw new Error('unexpected ' + url);
  };
  try {
    const out = await jira.worklogsByAuthor('r_x', { since: '2026-03-20' });
    assert.equal(out.issueCount, 101, 'the second search page is read too');
    assert.equal(out.capped, false);
    assert.equal(worklogCalls.length, 1, 'only the truncated issue costs its own request');
    assert.equal(out.entries.length, 99 + 25 + 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('worklogsByAuthor refuses a username that could break out of the JQL string', async () => {
  const jira = stubSecrets(CONFIGURED);
  const out = await jira.worklogsByAuthor('x" OR 1=1 --');
  assert.deepEqual(out.entries, []);
});
