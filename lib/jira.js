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

// Jira reports every duration in seconds; hours is the unit the team
// actually estimates in (4h, 10h, 20h), so convert once here rather than in
// every consumer.
// The ticket text, cut to the active engine's share of its context window
// instead of the flat 4000 characters this used to use — a number that was
// the same whether the review ran on a 32K router or a 1M-token Gemini, and
// that cut silently: a ticket with an eight-page spec reached the model as
// its first two pages with nothing to say the rest existed. The marker is in
// the text itself so the model (and anyone reading the prompt) can see it,
// and `descriptionTruncated` lets the report say so too.
function describeField(raw) {
  if (typeof raw !== 'string' || !raw) return { description: '', descriptionTruncated: false };
  const budget = require('./contextBudget');
  const fitted = budget.fit(
    raw,
    budget.budgetFor().jiraDescriptionChars,
    '\n[... باقی شرح این تسک به دلیل سقف حجم context به مدل داده نشد ...]'
  );
  return { description: fitted.text, descriptionTruncated: fitted.truncated };
}

function toHours(seconds) {
  return typeof seconds === 'number' && seconds > 0 ? Math.round((seconds / 3600) * 10) / 10 : null;
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
      ...describeField(fields.description),
      status: fields.status && fields.status.name,
      assignee: fields.assignee && fields.assignee.displayName,
      // Estimate/spent/due travel with the single-issue fetch too, not just
      // the assignee search — the review report quotes them, and re-fetching
      // the same issue a second way to get them would be silly.
      estimateHours: toHours(fields.timeoriginalestimate),
      spentHours: toHours(fields.timespent),
      dueDate: fields.duedate || null,
      priority: (fields.priority && fields.priority.name) || null,
      type: (fields.issuetype && fields.issuetype.name) || null,
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

// BUMP THIS whenever the shape either cache stores changes — a new field on
// an issue, a different wrapper around the search result. Both cache names
// derive from it, so one edit retires every stale entry at once.
//
// Learned the hard way, three times: adding fields without retiring the old
// entries doesn't look like a stale cache, it looks like the data isn't
// there — "this developer files no estimates", "this ticket has no due
// date" — which is far more misleading than an outright error.
const CACHE_VERSION = 2;
const ISSUE_CACHE = `jira-issue-v${CACHE_VERSION}`;
const SEARCH_CACHE = `jira-assignee-v${CACHE_VERSION}`;

// One issue, tolerant of failure: a bad/placeholder task key (branch names
// are free text — "EM-0000" shows up for real in this org's history) or a
// Jira outage must not take down the whole analytics response over one
// task. Returns null on any problem instead of throwing.
async function fetchIssueSafe(issueKey, { force = false } = {}) {
  if (!isConfigured() || !issueKey) return null;
  try {
    const { value } = await cache.cached(ISSUE_CACHE, issueKey, ISSUE_CACHE_TTL_MS, () => fetchIssue(issueKey), { force });
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
async function fetchIssuesByKeys(keys, { force = false } = {}) {
  const unique = Array.from(new Set((keys || []).filter(Boolean)));
  const map = new Map();
  if (!isConfigured() || !unique.length) return map;
  const results = await Promise.all(unique.map((k) => fetchIssueSafe(k, { force }).then((issue) => [k, issue])));
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

// Custom field ids are per-instance, so these were read off this Jira's own
// /rest/api/2/field rather than guessed. Checked against 40 real tickets on
// 2026-09-08: Original Estimate and Due date are filled on 100% of them,
// Time Spent on ~47%, Sprint on 90% — and **Story Points on none**, which is
// why the score in devScore.js is built on estimates and due dates rather
// than points. customfield_10107 is still requested so it starts counting
// for free if the team ever begins filling it.
const FIELD_STORY_POINTS = 'customfield_10107';
const FIELD_SPRINT = 'customfield_10105';
const SEARCH_FIELDS = [
  'summary', 'status', 'assignee', 'updated', 'created', 'issuetype', 'priority', 'project',
  'duedate', 'resolutiondate', 'resolution', 'labels',
  'timeoriginalestimate', 'timespent', 'timeestimate',
  FIELD_STORY_POINTS, FIELD_SPRINT,
].join(',');

// Jira serializes a sprint as the toString() of its Java object, e.g.
// "...Sprint@6d48cb6e[id=3222,rapidViewId=1568,state=ACTIVE,name=Sprint 41,...]".
// The name is the only part worth showing, so it's dug out of that rather
// than displayed raw. Newer instances sometimes return a proper object
// instead, so both shapes are handled.
function sprintName(raw) {
  const last = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  if (!last) return null;
  if (typeof last === 'object') return last.name || null;
  const m = String(last).match(/name=([^,\]]+)/);
  return m ? m[1] : null;
}


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
async function searchIssuesByAssignee(username, { since, until, force = false } = {}) {
  if (!isConfigured() || !isSafeUsername(username)) return { issues: [], total: 0 };
  const clauses = [`assignee = "${username}"`];
  if (/^\d{4}-\d{2}-\d{2}$/.test(since || '')) clauses.push(`updated >= "${since}"`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(until || '')) clauses.push(`updated <= "${until}"`);
  const jql = `${clauses.join(' AND ')} ORDER BY updated DESC`;
  const cacheKey = `${username}|${since || ''}|${until || ''}`;
  try {
    // See CACHE_VERSION above for why the name is versioned. The normalize
    // step below is the belt to those suspenders: whatever comes out of the
    // cache, the caller always gets { issues, total }.
    const { value } = await cache.cached(SEARCH_CACHE, cacheKey, SEARCH_CACHE_TTL_MS, async () => {
      const params = new URLSearchParams({
        jql,
        maxResults: String(MAX_SEARCH_RESULTS),
        fields: SEARCH_FIELDS,
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
            // statusCategory is the language-independent bucket ("done",
            // "indeterminate", "new") — the workflow's own status names are
            // team-specific text, so completion is judged on this instead.
            statusCategory: (fields.status && fields.status.statusCategory && fields.status.statusCategory.key) || null,
            type: (fields.issuetype && fields.issuetype.name) || null,
            priority: (fields.priority && fields.priority.name) || null,
            // Which Jira project the ticket lives in. The key prefix implies
            // it, but only if every project's prefix is unique and nobody
            // ever renames one — the field is the authoritative answer.
            project: (fields.project && (fields.project.name || fields.project.key)) || null,
            updated: fields.updated || null,
            created: fields.created || null,
            dueDate: fields.duedate || null,
            resolvedAt: fields.resolutiondate || null,
            estimateHours: toHours(fields.timeoriginalestimate),
            spentHours: toHours(fields.timespent),
            remainingHours: toHours(fields.timeestimate),
            storyPoints: typeof fields[FIELD_STORY_POINTS] === 'number' ? fields[FIELD_STORY_POINTS] : null,
            sprint: sprintName(fields[FIELD_SPRINT]),
            labels: Array.isArray(fields.labels) ? fields.labels : [],
            url: `${jiraBase()}/browse/${issue.key}`,
          };
        });
        return { issues, total: Number(json.total) || issues.length };
      } finally {
        clearTimeout(timer);
      }
    }, { force });
    if (Array.isArray(value)) return { issues: value, total: value.length };
    if (!value || !Array.isArray(value.issues)) return { issues: [], total: 0 };
    return value;
  } catch (e) {
    return { issues: [], total: 0 };
  }
}

// ---- epics -----------------------------------------------------------------
//
// Jira Server keeps the epic relationship in two custom fields rather than a
// first-class link: "Epic Name" on the epic itself, and "Epic Link" on the
// issues under it. Their numeric ids differ per installation, so they are
// discovered from /field rather than hardcoded — the values below are this
// org's (10103 / 10101), used only as the fallback if discovery fails.
const EPIC_CACHE = 'jira-epics-v1';
const EPIC_TTL_MS = 60 * 60 * 1000;
const FIELD_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FALLBACK_EPIC_NAME_FIELD = 'customfield_10103';
const FALLBACK_EPIC_LINK_FIELD = 'customfield_10101';

async function jiraGet(pathname, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${jiraBase()}${pathname}`, {
      headers: { Authorization: `Bearer ${secret('JIRA_API_TOKEN')}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (e) { json = text; }
    if (!res.ok) {
      const err = new Error(`Jira ${res.status}: ${typeof json === 'string' ? json.slice(0, 200) : JSON.stringify(json).slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return json;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Jira API timeout after ${timeoutMs / 1000}s: ${pathname}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Field ids are a property of the Jira install, not of a project, and they do
// not change — a day's cache, and a fallback so a failed lookup degrades to
// this org's known ids rather than breaking epic support entirely.
async function epicFields() {
  try {
    const { value } = await cache.cached(EPIC_CACHE, '__fields__', FIELD_CACHE_TTL_MS, async () => {
      const fields = await jiraGet('/rest/api/2/field');
      const find = (name) => {
        const hit = (fields || []).find((f) => String(f.name || '').toLowerCase() === name);
        return hit ? hit.id : null;
      };
      return {
        nameField: find('epic name') || FALLBACK_EPIC_NAME_FIELD,
        linkField: find('epic link') || FALLBACK_EPIC_LINK_FIELD,
      };
    });
    return value;
  } catch (e) {
    return { nameField: FALLBACK_EPIC_NAME_FIELD, linkField: FALLBACK_EPIC_LINK_FIELD };
  }
}

// Every epic in a project, newest first. Done epics are kept rather than
// filtered: a crash in a feature that shipped last quarter still belongs
// under that feature's epic, and hiding closed ones would send it to the
// wrong place or to none at all. The status travels with each so the UI can
// say which is which.
async function listEpics(projectKey, { force = false } = {}) {
  const key = String(projectKey || secret('JIRA_PROJECT_KEY') || '').trim();
  if (!isConfigured() || !key) return [];
  const { nameField } = await epicFields();
  const { value } = await cache.cached(EPIC_CACHE, key, EPIC_TTL_MS, async () => {
    const jql = encodeURIComponent(`project = ${key} AND issuetype = Epic ORDER BY created DESC`);
    const data = await jiraGet(`/rest/api/2/search?jql=${jql}&maxResults=200&fields=summary,status,${nameField}`);
    return (data.issues || []).map((i) => ({
      key: i.key,
      // The epic's own name where it has one; several of this org's epics
      // leave it empty and carry the title in summary instead.
      name: (i.fields && i.fields[nameField]) || (i.fields && i.fields.summary) || i.key,
      status: (i.fields && i.fields.status && i.fields.status.name) || null,
      done: !!(i.fields && i.fields.status && i.fields.status.statusCategory && i.fields.status.statusCategory.key === 'done'),
      url: `${jiraBase()}/browse/${i.key}`,
    }));
  }, { force });
  return value;
}

// ---- creating issues -------------------------------------------------------
//
// The first write this module does. Everything above only reads, and the
// separation is worth keeping visible: a read that fails is a blank badge,
// a write that fails halfway leaves a ticket somebody has to go clean up.
//
// Required fields on this install (Jira Server 9.4.9, project EM, discovered
// from /issue/createmeta/EM/issuetypes/<id> rather than assumed): project,
// issuetype, summary, duedate, timetracking.originalEstimate. Due date and
// estimate being *mandatory in the form* is also why this org's Jira shows
// 100% fill on both while Time Spent — not mandatory — sits near half.
const CREATE_TIMEOUT_MS = 20000;

function canCreate() {
  return isConfigured() && !!secret('JIRA_PROJECT_KEY');
}

// hours -> Jira's own duration syntax. Whole hours where possible, because
// "4h" is what a human would have typed and what the field displays back.
function toEstimateString(hours) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) return null;
  if (Number.isInteger(h)) return `${h}h`;
  const whole = Math.floor(h);
  const minutes = Math.round((h - whole) * 60);
  return whole ? `${whole}h ${minutes}m` : `${minutes}m`;
}

async function createIssue({ summary, description, issueType = 'Bug', dueDate, estimateHours, labels, priority, assignee, projectKey, epicKey }) {
  if (!canCreate() && !projectKey) throw new Error('جیرا برای ساخت تسک تنظیم نشده — JIRA_BASE_URL و JIRA_API_TOKEN و JIRA_PROJECT_KEY لازم‌اند.');
  if (!String(summary || '').trim()) throw new Error('عنوان تسک نمی‌تواند خالی باشد.');
  const estimate = toEstimateString(estimateHours);
  // Checked here rather than left to Jira: its 400 for a missing mandatory
  // field comes back as a nested errors object that reads like a bug in this
  // tool, not like "you left the estimate empty".
  if (!dueDate) throw new Error('Due Date اجباری است (این پروژه در جیرا آن را الزامی کرده).');
  if (!estimate) throw new Error('Original Estimate اجباری است (این پروژه در جیرا آن را الزامی کرده).');

  const fields = {
    // projectKey wins when given: which Jira project a ticket belongs in is
    // a per-repository fact (projects.getJiraProjectKey), and the
    // secrets.env value is only the fallback for a single-project setup.
    project: { key: projectKey || secret('JIRA_PROJECT_KEY') },
    issuetype: { name: issueType },
    summary: String(summary).trim().slice(0, 250), // Jira's own summary limit
    duedate: dueDate,                              // YYYY-MM-DD
    timetracking: { originalEstimate: estimate },
  };
  if (description) fields.description = String(description);
  if (Array.isArray(labels) && labels.length) fields.labels = labels;
  if (priority) fields.priority = { name: priority };
  // Jira Server takes a username here; Cloud wants an accountId. This org is
  // Server (9.4.9), which is also what the rest of this module assumes.
  if (assignee) fields.assignee = { name: assignee };
  // Epic Link is a plain custom field on Server, and its id is per-install —
  // discovered rather than hardcoded (see epicFields).
  if (epicKey) {
    const { linkField } = await epicFields();
    fields[linkField] = epicKey;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CREATE_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${jiraBase()}/rest/api/2/issue`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret('JIRA_API_TOKEN')}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields }),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Jira API timeout after ${CREATE_TIMEOUT_MS / 1000}s هنگام ساخت تسک`);
    throw e;
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { json = text; }
  if (!res.ok) {
    // Jira answers {errors:{duedate:"..."}, errorMessages:[...]}. Flattened
    // into one line so the dashboard can show why without the reader having
    // to open devtools to find the actual field name.
    const parts = [];
    if (json && json.errorMessages && json.errorMessages.length) parts.push(json.errorMessages.join(' · '));
    if (json && json.errors) parts.push(Object.entries(json.errors).map(([k, v]) => `${k}: ${v}`).join(' · '));
    throw new Error(`Jira ${res.status}: ${parts.join(' · ') || String(text).slice(0, 200)}`);
  }
  return { key: json.key, id: json.id, url: `${jiraBase()}/browse/${json.key}` };
}

module.exports = { ISSUE_CACHE, SEARCH_CACHE, EPIC_CACHE, listEpics, epicFields, isConfigured, canCreate, fetchIssue, fetchIssueSafe, fetchIssuesByKeys, searchIssuesByAssignee, createIssue, toEstimateString };
