// Groundwork for pulling Jira issue data into a review/analytics report —
// not wired into anything yet (2026-09-07: the user asked for this to exist
// ahead of a longer conversation about exactly what the report should show).
// Today, `task.extractTask()` already pulls a task key like "EM-2600" out of
// a branch name/title purely from string shape; the natural next step is
// looking that key up here (status, assignee, story points, due date) to
// enrich the Developer Analytics task list and/or the review/MR-<iid>.md
// report — but that's a product decision for the next conversation, not
// this one, so this file only proves the plumbing works: is Jira
// configured, and can we fetch one issue by key.
const { secret } = require('./ai_bridge');

function isConfigured() {
  return !!(secret('JIRA_BASE_URL') && secret('JIRA_EMAIL') && secret('JIRA_API_TOKEN'));
}

function jiraBase() {
  return (secret('JIRA_BASE_URL') || '').replace(/\/$/, '');
}

// GET /rest/api/3/issue/<key> — the same 15s-timeout-on-fetch pattern
// lib/gitlab.js uses, so a stalled Jira instance can't hang a report the way
// an unguarded fetch once did for GitLab (see gitlab.js's own comment on
// apiFetch). Returns null (not a throw) when Jira isn't configured at all,
// so a caller can treat "no Jira" and "Jira down" differently if it wants.
async function fetchIssue(issueKey, { timeoutMs = 15000 } = {}) {
  if (!isConfigured() || !issueKey) return null;
  const auth = Buffer.from(`${secret('JIRA_EMAIL')}:${secret('JIRA_API_TOKEN')}`).toString('base64');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${jiraBase()}/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
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

module.exports = { isConfigured, fetchIssue };
