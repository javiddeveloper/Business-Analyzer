// lib/projects.js: a project can now run its own GitLab/Jira/Sentry entirely
// (connections), not just its own project id/path/Jira key/Sentry slug.
// These tests cover the parts most likely to leak or silently regress:
// - a project without overrides must behave exactly as before (fallback)
// - a stored token must never reach a "public" view unmasked
// - editing one connection's token must not blank out another connection
// - the env-synthesized project (no connections at all) must not throw
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.CR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-projects-'));

function freshProjects() {
  delete require.cache[require.resolve('../lib/projects')];
  delete require.cache[require.resolve('../lib/ai_bridge')];
  return require('../lib/projects');
}

test('a project with no connections overrides nothing — secret(key, id) falls straight through', () => {
  const projects = freshProjects();
  projects.upsertProject({ id: '501', name: 'بدون اتصال جدا' });
  assert.equal(projects.connectionOverride('501', 'GITLAB_TOKEN'), '', 'never returns undefined — callers do `|| secret(key)` unconditionally');
  assert.equal(projects.connectionOverride('501', 'GITLAB_URL'), '');
  assert.equal(projects.connectionOverride('999-not-a-project', 'GITLAB_TOKEN'), '', 'an unknown id is not an error');
});

test('a project can run its own GitLab/Jira/Sentry, and connectionOverride finds each one', () => {
  const projects = freshProjects();
  projects.upsertProject({
    id: '502',
    name: 'زیرساخت مجزا',
    connections: {
      gitlab: { url: 'https://gitlab.other.example', token: 'glpat-xyz' },
      jira: { baseUrl: 'https://jira.other.example', token: 'jira-tok' },
      sentry: { url: 'https://sentry.other.example', org: 'other-org', token: 'sentry-tok' },
    },
  });
  assert.equal(projects.connectionOverride('502', 'GITLAB_URL'), 'https://gitlab.other.example');
  assert.equal(projects.connectionOverride('502', 'GITLAB_TOKEN'), 'glpat-xyz');
  assert.equal(projects.connectionOverride('502', 'JIRA_BASE_URL'), 'https://jira.other.example');
  assert.equal(projects.connectionOverride('502', 'JIRA_API_TOKEN'), 'jira-tok');
  assert.equal(projects.connectionOverride('502', 'SENTRY_URL'), 'https://sentry.other.example');
  assert.equal(projects.connectionOverride('502', 'SENTRY_ORG'), 'other-org');
  assert.equal(projects.connectionOverride('502', 'SENTRY_AUTH_TOKEN'), 'sentry-tok');
  // A key no project can override (there is no per-project ADMIN_TOKEN)
  // must not be mistaken for a blank override — it's simply not in the map.
  assert.equal(projects.connectionOverride('502', 'ADMIN_TOKEN'), '');
});

test('secret(key, projectId) prefers a project override, and secret(key) alone ignores it entirely', () => {
  const projects = freshProjects();
  const { secret } = require('../lib/ai_bridge');
  projects.upsertProject({ id: '503', name: 'p', connections: { gitlab: { token: 'project-own-token' } } });
  assert.equal(secret('GITLAB_TOKEN', '503'), 'project-own-token');
  // No projectId at all: the single-workspace behaviour every existing
  // caller relies on must be untouched by this project existing.
  assert.notEqual(secret('GITLAB_TOKEN'), 'project-own-token');
});

test('editing one connection does not blank out the others already saved', () => {
  const projects = freshProjects();
  projects.upsertProject({
    id: '504', name: 'p',
    connections: { gitlab: { token: 'g1' }, jira: { token: 'j1' } },
  });
  // Rotate only the GitLab token, the way the settings form would after the
  // person edits one field and saves.
  projects.upsertProject({ id: '504', name: 'p', connections: { gitlab: { token: 'g2' } } });
  assert.equal(projects.connectionOverride('504', 'GITLAB_TOKEN'), 'g2', 'the rotated token took');
  assert.equal(projects.connectionOverride('504', 'JIRA_API_TOKEN'), 'j1', "Jira's token must survive a GitLab-only edit");
});

test('an empty string in connections clears that field rather than storing a blank override', () => {
  const projects = freshProjects();
  projects.upsertProject({ id: '505', name: 'p', connections: { gitlab: { token: 'g1' } } });
  projects.upsertProject({ id: '505', name: 'p', connections: { gitlab: { token: '' } } });
  assert.equal(projects.connectionOverride('505', 'GITLAB_TOKEN'), '', "an explicit '' means \"go back to secrets.env\", not \"keep g1\"");
});

test("describeConnections masks every token and never returns the raw value", () => {
  const projects = freshProjects();
  projects.upsertProject({
    id: '506', name: 'p',
    connections: { gitlab: { url: 'https://g.example', token: 'supersecrettoken1234' } },
  });
  const d = projects.describeConnections('506');
  assert.equal(d.gitlab.url, 'https://g.example', 'a non-secret field is shown in full');
  assert.notEqual(d.gitlab.token, 'supersecrettoken1234');
  assert.match(d.gitlab.token, /^•+1234$/, "envFile.js's mask() convention: stars then the last 4 characters");
  assert.equal(d.gitlab.tokenSet, true);
  assert.equal(d.jira.tokenSet, false, 'a connection never configured reports unset, not a fake mask');
  assert.equal(d.jira.token, '');
});

test('publicProject/listProjectsPublic strip the raw connections object entirely', () => {
  const projects = freshProjects();
  const entry = projects.upsertProject({
    id: '507', name: 'p',
    connections: { sentry: { token: 'raw-sentry-token' } },
  });
  // The value upsertProject hands back to its own caller (server.js, before
  // it is sent on) still carries the raw token — that is the value that gets
  // written to disk. publicProject is the one required step before it goes
  // anywhere near an HTTP response.
  assert.equal(entry.connections.sentry.token, 'raw-sentry-token');
  const pub = projects.publicProject(entry);
  assert.equal(JSON.stringify(pub).includes('raw-sentry-token'), false, 'the raw token must not appear anywhere in the public shape');
  assert.equal(pub.connections.sentry.tokenSet, true);

  const list = projects.listProjectsPublic();
  const found = list.find((p) => p.id === '507');
  assert.ok(found);
  assert.equal(JSON.stringify(found).includes('raw-sentry-token'), false);
});

test('the env-synthesized project (no connections field at all) never throws', () => {
  const projects = freshProjects();
  // Simulates secrets.env's GITLAB_PROJECT_ID being set with nothing saved
  // to projects.json — envProject() returns an object with no `connections`
  // key, since it is never persisted.
  const d = projects.describeConnections('some-env-only-id');
  assert.deepEqual(d.gitlab, { url: '', token: '', tokenSet: false });
  assert.equal(projects.connectionOverride('some-env-only-id', 'GITLAB_TOKEN'), '');
});
