// lib/jira.js is groundwork only (nothing calls it yet) — this just proves
// the plumbing behaves before any feature is built on top of it: unconfigured
// by default, and fetchIssue refuses to guess at credentials that aren't there.
const test = require('node:test');
const assert = require('node:assert');

test('isConfigured is false until all three Jira secrets are set', () => {
  delete require.cache[require.resolve('../lib/ai_bridge')];
  delete require.cache[require.resolve('../lib/jira')];
  const resolved = require.resolve('../lib/ai_bridge');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: { secret: () => '' } };
  const jira = require('../lib/jira');
  assert.equal(jira.isConfigured(), false);
});

test('fetchIssue resolves to null (not a throw) when Jira is not configured', async () => {
  delete require.cache[require.resolve('../lib/ai_bridge')];
  delete require.cache[require.resolve('../lib/jira')];
  const resolved = require.resolve('../lib/ai_bridge');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: { secret: () => '' } };
  const jira = require('../lib/jira');
  assert.equal(await jira.fetchIssue('EM-1'), null);
});
