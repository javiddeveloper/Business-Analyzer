// Pulls Jira issue status/assignee into the Developer Analytics task list.
// `task.extractTask()` already pulls a task key like "EM-2600" out of a
// branch name/title purely from string shape — that key is the join to
// Jira, so no separate mapping table is needed.
//
// 2026-09-08: the user picked "status/assignee next to each MR's task" as
// the first (and for now only) Jira-backed stat — the lightest option of
// several discussed, and the one that reuses the task key already being
// extracted. Cycle-time and sprint/velocity stats were explicitly deferred.
//
// This org runs Jira self-hosted (jira.tamin.ir), not Jira Cloud, so this
// authenticates with a Personal Access Token (`Authorization: Bearer …`),
// the standard for Jira Server/Data Center 8.14+ — not Cloud's email+token
// Basic Auth, which self-hosted Jira doesn't accept. Also on `/rest/api/2/`
// rather than `/3/`: v2 is the version guaranteed present on every
// self-hosted release, and the handful of fields read here (summary,
// status, assignee) are identical between v2 and v3 anyway.
const { secret } = require('./ai_bridge');
const cache = require('./cache');

function isConfigured() {
  return !!(secret('JIRA_BASE_URL') && secret('JIRA_API_TOKEN'));
}

function jiraBase() {
  return (secret('JIRA_BASE_URL') || '').replace(/\/$/, '');
}

// GET /rest/api/2/issue/<key> — the same 15s-timeout-on-fetch pattern
// lib/gitlab.js uses, so a stalled Jira instance can't hang a report the way
// an unguarded fetch once did for GitLab (see gitlab.js's own comment on
// apiFetch). Returns null (not a throw) when Jira isn't configured at all,
// so a caller can treat "no Jira" and "Jira down" differently if it wants.
async function fetchIssue(issueKey, { timeoutMs = 15000 } = {}) {
  if (!isConfigured() || !issueKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${jiraBase()}/rest/api/2/issue/${encodeURIComponent(issueKey)}`, {
      headers: { Authorization: `Bearer ${secret('JIRA_API_TOKEN')}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Jira API ${res.status}`);
    const json = await res.json();
    const fields = json.fields || {};
    return {
      key: json.key,
      summary: fields.summary,
      // What the task actually asked for — the part that lets a review ask
      // "does this code do what the ticket wanted?" instead of only "is this
      // code clean?". Capped: some tickets carry pages of pasted context, and
      // this rides along in every review prompt. /rest/api/2 returns this as
      // plain wiki-markup text (Cloud's v3 would return an ADF object here,
      // which would need flattening — another reason v2 suits us).
      description: typeof fields.description === 'string' ? fields.description.slice(0, 4000) : '',
      status: fields.status && fields.status.name,
      assignee: fields.assignee && fields.assignee.displayName,
      url: `${jiraBase()}/browse/${json.key}`,
    };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Jira API timeout after ${timeoutMs / 1000}s: ${issueKey}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Status/assignee don't change minute-to-minute, so a per-issue cache well
// short of the Developer Analytics cache (20 min — see server.js) still
// avoids hammering Jira on every page load while staying reasonably fresh.
const ISSUE_CACHE_TTL_MS = 10 * 60 * 1000;

// One issue, tolerant of failure: a bad/placeholder task key (branch names
// are free text — "EM-0000" shows up for real in this org's history) or a
// Jira outage must not take down the whole analytics response over one
// task. Returns null on any problem instead of throwing.
async function fetchIssueSafe(issueKey) {
  if (!isConfigured() || !issueKey) return null;
  try {
    const { value } = await cache.cached('jira-issue', issueKey, ISSUE_CACHE_TTL_MS, () => fetchIssue(issueKey));
    return value;
  } catch (e) {
    return null;
  }
}

// Enriches a whole batch of task keys at once — the Developer Analytics
// page can easily have dozens of distinct ones in a single response.
// Deduped (the same task key legitimately repeats across several MRs) and
// fetched in parallel; each key's own cache means a second developer who
// touched the same task pays nothing extra.
async function fetchIssuesByKeys(keys) {
  const unique = Array.from(new Set((keys || []).filter(Boolean)));
  const map = new Map();
  if (!isConfigured() || !unique.length) return map;
  const results = await Promise.all(unique.map((k) => fetchIssueSafe(k).then((issue) => [k, issue])));
  for (const [k, issue] of results) map.set(k, issue);
  return map;
}

// A username is about to be interpolated into a JQL string, so it's held to
// the shape a real account name has (this org's are `j_sattar`-style, and
// Jira's own /myself confirmed the same username scheme as GitLab). Anything
// with a quote, backslash or space in it is refused rather than escaped —
// there is no legitimate roster name that needs them, and refusing is the
// one option that can't be got wrong.
function isSafeUsername(username) {
  return /^[A-Za-z0-9._@-]{1,64}$/.test(String(username || ''));
}

const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_SEARCH_RESULTS = 100;

// Every Jira issue assigned to one person — including the ones with no MR
// yet, which is the entire point: "assigned vs delivered" is invisible if
// you only ever look at issues that already produced a merge request.
//
// `since`/`until` (YYYY-MM-DD, from the analytics page's date filter) bound
// it by *last updated*, not created: for "what has this person been working
// on in this window", a ticket opened last quarter and worked on last week
// belongs in last week's window.
//
// Returns { issues, total } — `total` is Jira's own count for the query,
// which can exceed MAX_SEARCH_RESULTS, so the caller can say "showing 100
// of 340" instead of quietly presenting a capped list as the whole picture.
// Never throws: an unusable username, an unconfigured Jira, or a failed
// search all answer an empty result rather than taking down the analytics
// page that hosts it.
async function searchIssuesByAssignee(username, { since, until } = {}) {
  if (!isConfigured() || !isSafeUsername(username)) return { issues: [], total: 0 };
  const clauses = [`assignee = "${username}"`];
  if (/^\d{4}-\d{2}-\d{2}$/.test(since || '')) clauses.push(`updated >= "${since}"`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(until || '')) clauses.push(`updated <= "${until}"`);
  const jql = `${clauses.join(' AND ')} ORDER BY updated DESC`;
  const cacheKey = `${username}|${since || ''}|${until || ''}`;
  try {
    // Cache name carries a version: this used to cache a bare array and now
    // caches { issues, total }. Reading the old shape back after an upgrade
    // crashed the whole analytics page on `.issues.map` — a fresh namespace
    // makes stale entries unreachable instead of mis-shaped. The normalize
    // step below is the belt to that suspenders: whatever comes out of the
    // cache, the caller always gets { issues, total }.
    const { value } = await cache.cached('jira-assignee-v2', cacheKey, SEARCH_CACHE_TTL_MS, async () => {
      const params = new URLSearchParams({
        jql,
        maxResults: String(MAX_SEARCH_RESULTS),
        fields: 'summary,status,assignee,updated,created,issuetype',
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const res = await fetch(`${jiraBase()}/rest/api/2/search?${params.toString()}`, {
          headers: { Authorization: `Bearer ${secret('JIRA_API_TOKEN')}`, Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`Jira search ${res.status}`);
        const json = await res.json();
        const issues = (json.issues || []).map((issue) => {
          const fields = issue.fields || {};
          return {
            key: issue.key,
            summary: fields.summary || '',
            status: (fields.status && fields.status.name) || null,
            type: (fields.issuetype && fields.issuetype.name) || null,
            updated: fields.updated || null,
            created: fields.created || null,
            url: `${jiraBase()}/browse/${issue.key}`,
          };
        });
        return { issues, total: Number(json.total) || issues.length };
      } finally {
        clearTimeout(timer);
      }
    });
    if (Array.isArray(value)) return { issues: value, total: value.length };
    if (!value || !Array.isArray(value.issues)) return { issues: [], total: 0 };
    return value;
  } catch (e) {
    return { issues: [], total: 0 };
  }
}

module.exports = { isConfigured, fetchIssue, fetchIssueSafe, fetchIssuesByKeys, searchIssuesByAssignee };
