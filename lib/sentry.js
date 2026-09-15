// Sentry, read-only: list the unresolved issues a team should be looking at,
// so one of them can be turned into a Jira task without leaving the
// dashboard (server.js's /api/sentry/* routes).
//
// Self-hosted, like this org's GitLab and Jira, so the base URL is
// configured rather than assumed. The REST surface is the same either way —
// /api/0/ — but a hardcoded sentry.io would simply not reach this install.
//
// Nothing here writes to Sentry. Resolving, assigning and ignoring stay in
// Sentry's own UI where the whole team can see them; this integration exists
// to get an error into the backlog, not to become a second place where issue
// state lives and the two drift apart. That is also why the token needs only
// the three read scopes.
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
async function listIssues({ query = 'is:unresolved', statsPeriod = '14d', limit = 50 } = {}) {
  const slugs = projectSlugs();
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

// Cheapest call that proves the token, the org and the URL all work, for the
// dashboard's status badge — same role /user plays for GitLab.
async function checkConnection() {
  const org = secret('SENTRY_ORG');
  const info = await apiFetch(`/organizations/${encodeURIComponent(org)}/`, { timeoutMs: 8000 });
  return { ok: true, org: info.slug || org, name: info.name || null };
}

module.exports = { isConfigured, listIssues, checkConnection, projectSlugs, sentryBase, levelRank };
