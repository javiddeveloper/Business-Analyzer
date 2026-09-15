// Multiple GitLab projects, one dashboard. Everything before this file
// assumed a single project (GITLAB_PROJECT_ID + PROJECT_PATH in secrets.env)
// — fine for one repo, but the team has more than one, and Developer
// Analytics in particular needs to see a person's MRs across all of them,
// not just whichever one happens to be configured.
//
// secrets.env's GITLAB_PROJECT_ID/PROJECT_PATH still work and become the
// first entry automatically — nothing breaks for someone who never opens
// the new "پروژه‌ها" settings tab. Add more from there once you need them.
const fs = require('fs');
const { atomicWriteFileSync } = require('./atomicWrite');
const path = require('path');
const { secret } = require('./ai_bridge');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.CR_DATA_DIR ? path.resolve(process.env.CR_DATA_DIR) : path.join(ROOT, 'data');
const PROJECTS_PATH = path.join(DATA, 'projects.json');

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
// into the backend's backlog. The Sentry URL/org and the Jira URL/token stay
// global — there is one Sentry install and one Jira here, and duplicating
// credentials per project would mean rotating a token in four places.
//
// Both fall back to the SENTRY_PROJECT / JIRA_PROJECT_KEY in secrets.env, so
// a single-project setup keeps working with nothing filled in here.
function upsertProject({ id, name, path: repoPath, sentryProject, jiraProjectKey }) {
  if (!id) throw new Error('شناسه پروژه (GitLab project id) لازم است');
  const raw = readRaw();
  const list = Array.isArray(raw.list) ? raw.list : [];
  const idx = list.findIndex((p) => String(p.id) === String(id));
  const entry = {
    id: String(id),
    name: String(name || '').trim() || `پروژه ${id}`,
    path: String(repoPath || '').trim(),
    sentryProject: String(sentryProject || '').trim(),
    jiraProjectKey: String(jiraProjectKey || '').trim().toUpperCase(),
  };
  if (idx >= 0) list[idx] = entry; else list.push(entry);
  raw.list = list;
  writeRaw(raw);
  return entry;
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

function removeProject(id) {
  const raw = readRaw();
  raw.list = (Array.isArray(raw.list) ? raw.list : []).filter((p) => String(p.id) !== String(id));
  if (String(raw.activeId) === String(id)) raw.activeId = null;
  writeRaw(raw);
}

module.exports = { listProjects, getProject, getProjectPath, getSentryProjects, getJiraProjectKey, getActiveProjectId, setActiveProjectId, upsertProject, removeProject };
