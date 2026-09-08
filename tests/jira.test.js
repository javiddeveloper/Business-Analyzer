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
