// Multiple GitLab projects, one dashboard. Everything before this file
// assumed a single project (GITLAB_PROJECT_ID + PROJECT_PATH in secrets.env)
// — fine for one repo, but the team has more than one, and Developer
// Analytics in particular needs to see a person's MRs across all of them,
// not just whichever one happens to be configured.
//
// secrets.env's GITLAB_PROJECT_ID/PROJECT_PATH still work and become the
// first entry automatically — nothing breaks for someone who never opens
// the new "پروژه‌ها" settings tab. Add more from there once you need them.
//
// `connections` lets a project go further than id/path/sentryProject/
// jiraProjectKey and run its own GitLab/Jira/Sentry entirely — a different
// self-hosted GitLab, a different Jira, a different Sentry org, not just a
// different project id on the same ones. Each field is optional; an empty
// one falls back to secrets.env's global value (connectionOverride below),
// so a single-workspace setup that never fills these in behaves exactly as
// before. Tokens live here in plaintext the same way GITLAB_TOKEN lives in
// secrets.env — data/ is gitignored for the same reason secrets.env is.
const fs = require('fs');
const { atomicWriteFileSync } = require('./atomicWrite');
const path = require('path');
const { secret } = require('./ai_bridge');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.CR_DATA_DIR ? path.resolve(process.env.CR_DATA_DIR) : path.join(ROOT, 'data');
const PROJECTS_PATH = path.join(DATA, 'projects.json');

// Maps the secrets.env key a caller already knows (GITLAB_TOKEN, and so on)
// to where that project's own override for it lives, so secret(key, projectId)
// in ai_bridge.js has one place to look regardless of which connection the
// key belongs to.
const OVERRIDE_PATH = {
  GITLAB_URL: ['gitlab', 'url'],
  GITLAB_TOKEN: ['gitlab', 'token'],
  JIRA_BASE_URL: ['jira', 'baseUrl'],
  JIRA_API_TOKEN: ['jira', 'token'],
  SENTRY_URL: ['sentry', 'url'],
  SENTRY_ORG: ['sentry', 'org'],
  SENTRY_AUTH_TOKEN: ['sentry', 'token'],
};

function ensureDir() {
  fs.mkdirSync(DATA, { recursive: true });
}

function readRaw() {
  try {
    return JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf8'));
  } catch (e) {
    return { list: [], activeId: null };
  }
}

function writeRaw(data) {
  ensureDir();
  atomicWriteFileSync(PROJECTS_PATH, JSON.stringify(data, null, 2));
}

// The secrets.env project, synthesized as a list entry so callers never have
// to special-case "no projects configured yet" separately from "one project
// configured the old way". Not persisted to projects.json.
function envProject() {
  const id = secret('GITLAB_PROJECT_ID');
  if (!id) return null;
  return { id: String(id), name: 'پیش‌فرض (.env)', path: secret('PROJECT_PATH') || '', sentryProject: '', jiraProjectKey: '', fromEnv: true };
}

// Every configured project, env one first if present and not already
// duplicated in the saved list (editing it from the settings tab replaces
// the synthesized entry rather than showing it twice).
function listProjects() {
  const raw = readRaw();
  const saved = Array.isArray(raw.list) ? raw.list : [];
  const env = envProject();
  const savedIds = new Set(saved.map((p) => String(p.id)));
  const merged = env && !savedIds.has(env.id) ? [env, ...saved] : saved.slice();
  return merged;
}

function getProject(id) {
  if (id == null) return null;
  return listProjects().find((p) => String(p.id) === String(id)) || null;
}

function getProjectPath(id) {
  const p = getProject(id);
  return (p && p.path) || '';
}

function getActiveProjectId() {
  const raw = readRaw();
  const all = listProjects();
  if (raw.activeId && all.some((p) => String(p.id) === String(raw.activeId))) return String(raw.activeId);
  return all.length ? String(all[0].id) : null;
}

function setActiveProjectId(id) {
  const raw = readRaw();
  raw.activeId = id != null ? String(id) : null;
  writeRaw(raw);
  return getActiveProjectId();
}

// id/name/path — id is the GitLab numeric project id (as a string), same
// value used throughout the codebase as `projectId`. Editing an existing id
// overwrites that entry; the synthesized env entry becomes a normal saved
// one the first time it's edited.
// sentryProject and jiraProjectKey are per-repository on purpose: one GitLab
// project has its own Sentry project collecting its crashes and its own Jira
// project taking its tickets, and a shared setting would file a mobile crash
// into the backend's backlog.
//
// Both fall back to the SENTRY_PROJECT / JIRA_PROJECT_KEY in secrets.env, so
// a single-project setup keeps working with nothing filled in here. The same
// is now true of the connections themselves (connections.gitlab/jira/sentry)
// — for most teams there is one GitLab install and one Jira, so those stay
// blank and secrets.env keeps deciding; a project only needs them filled in
// once it genuinely lives somewhere else.
//
// `connections` merges shallowly onto whatever the project already had —
// passing only `{ gitlab: { token: '…' } }` to update a rotated token must
// not silently blank out that project's own Jira/Sentry connection, and a
// field left as '' (the settings form's "leave blank to keep secrets.env"
// convention) is dropped rather than stored as an empty override.
function mergeConnections(existing, incoming) {
  const merged = { gitlab: { ...(existing.gitlab || {}) }, jira: { ...(existing.jira || {}) }, sentry: { ...(existing.sentry || {}) } };
  for (const kind of ['gitlab', 'jira', 'sentry']) {
    const fields = (incoming && incoming[kind]) || {};
    for (const [field, value] of Object.entries(fields)) {
      if (value == null) continue;
      const v = String(value).trim();
      if (v) merged[kind][field] = v; else delete merged[kind][field];
    }
  }
  return merged;
}

function upsertProject({ id, name, path: repoPath, sentryProject, jiraProjectKey, connections }) {
  if (!id) throw new Error('شناسه پروژه (GitLab project id) لازم است');
  const raw = readRaw();
  const list = Array.isArray(raw.list) ? raw.list : [];
  const idx = list.findIndex((p) => String(p.id) === String(id));
  const existing = idx >= 0 ? list[idx] : {};
  const entry = {
    id: String(id),
    name: String(name || '').trim() || `پروژه ${id}`,
    path: String(repoPath || '').trim(),
    sentryProject: String(sentryProject || '').trim(),
    jiraProjectKey: String(jiraProjectKey || '').trim().toUpperCase(),
    connections: mergeConnections(existing.connections || {}, connections),
  };
  if (idx >= 0) list[idx] = entry; else list.push(entry);
  raw.list = list;
  writeRaw(raw);
  return entry;
}

// The one lookup ai_bridge.js's secret(key, projectId) needs: does this
// project override this secrets.env key, and if so with what. Returns '' —
// never throws, never returns undefined — so a caller can always fall
// straight through to `|| secret(key)` without a special case.
function connectionOverride(id, key) {
  const target = OVERRIDE_PATH[key];
  if (!target) return '';
  const p = getProject(id);
  if (!p || !p.connections) return '';
  const [kind, field] = target;
  return (p.connections[kind] && p.connections[kind][field]) || '';
}

// Same shape a project entry carries, but every secret masked (envFile.js's
// convention) — what the settings tab is allowed to see. A field the project
// never set stays '' rather than becoming a fake "•••• (nothing)".
function describeConnections(id) {
  const p = getProject(id);
  const c = (p && p.connections) || {};
  const mask = require('./envFile').mask;
  return {
    gitlab: { url: (c.gitlab && c.gitlab.url) || '', token: mask(c.gitlab && c.gitlab.token), tokenSet: !!(c.gitlab && c.gitlab.token) },
    jira: { baseUrl: (c.jira && c.jira.baseUrl) || '', token: mask(c.jira && c.jira.token), tokenSet: !!(c.jira && c.jira.token) },
    sentry: { url: (c.sentry && c.sentry.url) || '', org: (c.sentry && c.sentry.org) || '', token: mask(c.sentry && c.sentry.token), tokenSet: !!(c.sentry && c.sentry.token) },
  };
}

// The Sentry project slug(s) for one configured project, or — when it has
// none of its own — whatever SENTRY_PROJECT holds. Comma-separated either
// way, since one repo can report into more than one Sentry project.
function getSentryProjects(id) {
  const p = getProject(id);
  const raw = (p && p.sentryProject) || secret('SENTRY_PROJECT') || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function getJiraProjectKey(id) {
  const p = getProject(id);
  return (p && p.jiraProjectKey) || secret('JIRA_PROJECT_KEY') || '';
}

// A project entry the way it may leave this process — the raw one with its
// plaintext tokens has no business in an HTTP response. Every call site that
// sends a project (or the list) to the browser goes through this instead of
// touching the stored entry directly, the same discipline envFile.js's
// describe() applies to secrets.env.
function publicProject(p) {
  if (!p) return p;
  const { connections, ...rest } = p;
  return { ...rest, connections: describeConnections(p.id) };
}

function listProjectsPublic() {
  return listProjects().map(publicProject);
}

function removeProject(id) {
  const raw = readRaw();
  raw.list = (Array.isArray(raw.list) ? raw.list : []).filter((p) => String(p.id) !== String(id));
  if (String(raw.activeId) === String(id)) raw.activeId = null;
  writeRaw(raw);
}

module.exports = { listProjects, getProject, getProjectPath, getSentryProjects, getJiraProjectKey, getActiveProjectId, setActiveProjectId, upsertProject, removeProject, connectionOverride, describeConnections, publicProject, listProjectsPublic };
