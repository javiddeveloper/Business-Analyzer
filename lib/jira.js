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
    return {
      key: json.key,
      summary: json.fields && json.fields.summary,
      status: json.fields && json.fields.status && json.fields.status.name,
      assignee: json.fields && json.fields.assignee && json.fields.assignee.displayName,
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

module.exports = { isConfigured, fetchIssue, fetchIssuesByKeys };
