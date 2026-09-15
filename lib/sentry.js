// Sentry, read-only: list the unresolved issues a team should be looking at,
// so one of them can be turned into a Jira task without leaving the
// dashboard (server.js's /api/sentry/* routes).
//
// Self-hosted, like this org's GitLab and Jira, so the base URL is
// configured rather than assumed. The REST surface is the same either way —
// /api/0/ — but a hardcoded sentry.io would simply not reach this install.
//
// Almost all of it reads. The one write is setIssueStatus — marking an issue
// resolved. That deliberately goes to Sentry itself rather than to a "fixed"
// flag kept here, because a local flag would be a second place where issue
// state lives, disagreeing with what the team sees in Sentry's own UI. It is
// also the only reason the token needs event:write on top of the three read
// scopes (org:read, project:read, event:read).
const { secret } = require('./ai_bridge');

const DEFAULT_TIMEOUT_MS = 15000;

// Same reasoning as gitlab.js: without a timeout a single stalled connection
// hangs the dashboard request forever, and this one is called on page load.
async function apiFetch(pathname, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const base = sentryBase();
  if (!base) throw new Error('SENTRY_URL تنظیم نشده است.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${base}/api/0${pathname}`, {
      headers: { Authorization: `Bearer ${secret('SENTRY_AUTH_TOKEN')}`, Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Sentry API timeout after ${timeoutMs / 1000}s: ${pathname}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { json = text; }
  if (!res.ok) {
    const detail = typeof json === 'string' ? json.slice(0, 300) : JSON.stringify(json).slice(0, 300);
    const err = new Error(`Sentry API ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

function sentryBase() {
  return (secret('SENTRY_URL') || '').replace(/\/+$/, '');
}

function isConfigured() {
  return !!(sentryBase() && secret('SENTRY_AUTH_TOKEN') && secret('SENTRY_ORG') && projectSlugs().length);
}

// Comma-separated, because a mobile org usually has at least an app project
// and a backend one and the interesting errors are split across both.
function projectSlugs() {
  return (secret('SENTRY_PROJECT') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Sentry's own severity vocabulary, most severe first. Kept as an explicit
// order rather than sorted alphabetically so "worst first" in the UI means
// what it says.
const LEVEL_ORDER = { fatal: 0, error: 1, warning: 2, info: 3, debug: 4, sample: 5 };

function levelRank(level) {
  const l = String(level || '').toLowerCase();
  return LEVEL_ORDER[l] == null ? 9 : LEVEL_ORDER[l];
}

// Only the fields the dashboard actually shows or the Jira description
// quotes. Sentry's issue payload is large and mostly irrelevant here, and
// passing it through whole would put a lot of noise into the API response
// the browser polls.
function normalizeIssue(raw, projectSlug) {
  const meta = raw.metadata || {};
  return {
    id: String(raw.id),
    shortId: raw.shortId || null,
    project: (raw.project && raw.project.slug) || projectSlug,
    title: raw.title || meta.type || meta.value || '(بدون عنوان)',
    // "Where", in Sentry's own words — the function/route it blames. Often
    // more useful than the title for deciding who should own the fix.
    culprit: raw.culprit || meta.function || null,
    value: meta.value || null,
    level: String(raw.level || '').toLowerCase() || null,
    status: raw.status || null,
    count: Number(raw.count) || 0,
    userCount: Number(raw.userCount) || 0,
    firstSeen: raw.firstSeen || null,
    lastSeen: raw.lastSeen || null,
    permalink: raw.permalink || `${sentryBase()}/organizations/${secret('SENTRY_ORG')}/issues/${raw.id}/`,
  };
}

// Unresolved issues across every configured project, worst first.
//
// One request per project rather than a cross-project search: the
// organization-wide endpoint needs a numeric project id list and an extra
// lookup to translate slugs, while the per-project route takes the slug
// that is already in the config. A failure on one project is reported
// against that project instead of emptying the whole list — the same
// per-row isolation the team view uses.
async function listIssues({ query = 'is:unresolved', statsPeriod = '14d', limit = 50, projects } = {}) {
  const slugs = projects && projects.length ? projects : projectSlugs();
  const org = secret('SENTRY_ORG');
  const issues = [];
  const errors = [];

  await Promise.all(slugs.map(async (slug) => {
    const qs = new URLSearchParams({ query, statsPeriod, limit: String(limit) });
    try {
      const raw = await apiFetch(`/projects/${encodeURIComponent(org)}/${encodeURIComponent(slug)}/issues/?${qs}`);
      for (const item of Array.isArray(raw) ? raw : []) issues.push(normalizeIssue(item, slug));
    } catch (e) {
      errors.push({ project: slug, error: e.message });
    }
  }));

  issues.sort((a, b) => {
    const byLevel = levelRank(a.level) - levelRank(b.level);
    if (byLevel) return byLevel;
    return b.count - a.count; // then loudest first
  });

  return { issues, errors, projects: slugs };
}

// ---- one issue, in detail --------------------------------------------------

// The stack frames, innermost-last as Sentry stores them. Only the fields a
// reader (or the model writing the Persian explanation) actually needs —
// a raw Sentry event carries the whole request, every SDK package version
// and all the breadcrumbs, which is megabytes of context nobody asked for.
function extractStack(entries) {
  const out = [];
  for (const entry of entries || []) {
    if (entry.type !== 'exception') continue;
    for (const value of (entry.data && entry.data.values) || []) {
      const frames = ((value.stacktrace && value.stacktrace.frames) || []).map((f) => ({
        filename: f.filename || f.module || null,
        function: f.function || null,
        lineNo: f.lineNo == null ? null : f.lineNo,
        // "Ours vs the framework's" — Sentry's own classification, and the
        // single most useful thing for deciding where to start reading.
        inApp: !!f.inApp,
        context: (f.context || []).map(([line, text]) => ({ line, text })),
      }));
      out.push({ type: value.type || null, value: value.value || null, frames });
    }
  }
  return out;
}

// The most recent event for an issue: the actual crash, with its stack, tags
// and the device/release context. `latest` rather than a specific event id
// because the question being answered is "what does this look like now".
async function issueDetail(issueId) {
  const [issue, event] = await Promise.all([
    apiFetch(`/issues/${encodeURIComponent(issueId)}/`),
    // A brand-new issue can briefly have no stored event; that is not fatal,
    // the list data alone is still worth showing.
    apiFetch(`/issues/${encodeURIComponent(issueId)}/events/latest/`).catch(() => null),
  ]);

  const tags = {};
  for (const t of (event && event.tags) || []) if (t.key) tags[t.key] = t.value;

  return {
    ...normalizeIssue(issue, (issue.project && issue.project.slug) || null),
    exceptions: extractStack(event && event.entries),
    tags,
    release: tags.release || null,
    environment: tags.environment || null,
    eventId: (event && event.eventID) || null,
    eventDate: (event && event.dateCreated) || null,
  };
}

// The only write this module does, and the reason the token needs
// event:write on top of the three read scopes. Marking an issue resolved in
// Sentry rather than only in this dashboard is the point — a "fixed" flag
// that lives here alone would disagree with what the team sees in Sentry.
async function setIssueStatus(issueId, status) {
  const allowed = ['resolved', 'unresolved', 'ignored'];
  if (!allowed.includes(status)) throw new Error(`وضعیت نامعتبر: ${status}`);
  const base = sentryBase();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${base}/api/0/issues/${encodeURIComponent(issueId)}/`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${secret('SENTRY_AUTH_TOKEN')}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status }),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Sentry API timeout after ${DEFAULT_TIMEOUT_MS / 1000}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    // 403 here almost always means one thing, and saying so beats making
    // somebody go read Sentry's scope documentation to find out.
    const hint = res.status === 403
      ? ' — توکن Sentry اسکوپ نوشتن (event:write) ندارد.'
      : '';
    throw new Error(`Sentry API ${res.status}: ${text.slice(0, 200)}${hint}`);
  }
  try { return JSON.parse(text); } catch (e) { return { status }; }
}

// Cheapest call that proves the token, the org and the URL all work, for the
// dashboard's status badge — same role /user plays for GitLab.
async function checkConnection() {
  const org = secret('SENTRY_ORG');
  const info = await apiFetch(`/organizations/${encodeURIComponent(org)}/`, { timeoutMs: 8000 });
  return { ok: true, org: info.slug || org, name: info.name || null };
}

module.exports = { isConfigured, listIssues, issueDetail, setIssueStatus, checkConnection, projectSlugs, sentryBase, levelRank, extractStack };
