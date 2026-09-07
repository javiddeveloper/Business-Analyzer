// Thin GitLab REST (v4) client: read an MR's diff, list open MRs, post a note,
// check the connection, and verify an inbound webhook token.
const { secret } = require('./ai_bridge');

function gitlabBase() {
  return (secret('GITLAB_URL') || 'https://gitlab.com').replace(/\/$/, '');
}

async function apiFetch(pathname, options = {}) {
  const url = `${gitlabBase()}/api/v4${pathname}`;
  const headers = Object.assign(
    { 'PRIVATE-TOKEN': secret('GITLAB_TOKEN'), 'Content-Type': 'application/json' },
    options.headers || {}
  );
  const res = await fetch(url, { ...options, headers });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { json = text; }
  if (!res.ok) {
    const detail = typeof json === 'string' ? json.slice(0, 300) : JSON.stringify(json).slice(0, 300);
    const err = new Error(`GitLab API ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// GET /projects/:id/merge_requests/:iid/changes — returns { changes: [...] } among other MR fields.
function getMergeRequestChanges(projectId, mrIid) {
  return apiFetch(`/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/changes`);
}

// POST /projects/:id/merge_requests/:iid/notes — plain (non-inline) comment on the MR.
function postNote(projectId, mrIid, body) {
  return apiFetch(`/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/notes`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

// POST /projects/:id/merge_requests/:iid/discussions — an inline comment
// anchored to a line of the diff. `position` must describe a line GitLab can
// actually find in that diff, otherwise it answers 400.
function createDiscussion(projectId, mrIid, body, position) {
  return apiFetch(`/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/discussions`, {
    method: 'POST',
    body: JSON.stringify({ body, position }),
  });
}

// Existing discussions, used to avoid re-posting a finding that's already on
// the MR from an earlier review round.
function listDiscussions(projectId, mrIid) {
  return apiFetch(`/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/discussions?per_page=100`);
}

// POST /projects/:id/merge_requests/:iid/approve — approves the MR under the
// token's own account. Deliberately never merges: that stays a human action,
// see the "merging is not the reviewer's job" note this product inherited
// from the manual review process it's modeled on.
function approveMergeRequest(projectId, mrIid) {
  return apiFetch(`/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/approve`, {
    method: 'POST',
  });
}

// GET /user — used purely as a connection/credential check for the dashboard's
// status badge, since it's the cheapest call that actually proves the token works.
function getCurrentUser() {
  return apiFetch('/user');
}

// Open MRs to show as tabs. Scoped to GITLAB_PROJECT_ID when set; otherwise
// every open MR the token can see (scope=all — GitLab's default scope is
// created_by_me, which would hide MRs opened by teammates).
//
// Ordered oldest-created-first on purpose: the team's merge order follows
// creation order, so the dashboard, auto-review, and the auto-approve
// ordering gate (jobs.js's mergeOrderGate) all need to see the same order to
// agree on "which MRs come before this one".
function listOpenMergeRequests() {
  const projectId = secret('GITLAB_PROJECT_ID');
  const q = 'state=opened&order_by=created_at&sort=asc&per_page=50';
  return projectId
    ? apiFetch(`/projects/${encodeURIComponent(projectId)}/merge_requests?${q}`)
    : apiFetch(`/merge_requests?scope=all&${q}`);
}

// Follows page=1,2,3... until a page comes back short of per_page (the
// standard "last page" signal) or maxPages is hit — a hard cap so a
// developer with years of history can't turn one analytics request into an
// unbounded crawl of GitLab's API.
async function apiFetchAll(pathname, { maxPages = 5 } = {}) {
  const sep = pathname.includes('?') ? '&' : '?';
  const perPage = 100;
  let all = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await apiFetch(`${pathname}${sep}per_page=${perPage}&page=${page}`);
    if (!Array.isArray(batch) || !batch.length) break;
    all = all.concat(batch);
    if (batch.length < perPage) break;
  }
  return all;
}

// Every MR by one author, any state, optionally bounded to a date range —
// the basis for "how many MRs has this person actually opened", which the
// open-MRs-only list (listOpenMergeRequests) can't answer on its own.
function listAuthorMergeRequests(authorUsername, { since, until } = {}) {
  const projectId = secret('GITLAB_PROJECT_ID');
  const params = new URLSearchParams({ state: 'all', order_by: 'created_at', sort: 'asc', author_username: authorUsername });
  if (since) params.set('created_after', since);
  if (until) params.set('created_before', until);
  const q = params.toString();
  return apiFetchAll(
    projectId ? `/projects/${encodeURIComponent(projectId)}/merge_requests?${q}` : `/merge_requests?scope=all&${q}`
  );
}

// Distinct commit authors on a branch (by email, the one identity git commits
// always carry) — the basis for the "round trip" signal: more than one
// person committing to someone's feature branch usually means someone else
// had to step in and fix it up.
async function listBranchAuthors(projectId, branchName) {
  const commits = await apiFetchAll(
    `/projects/${encodeURIComponent(projectId)}/repository/commits?ref_name=${encodeURIComponent(branchName)}`,
    { maxPages: 3 }
  );
  const byEmail = new Map();
  for (const c of commits) {
    const email = (c.author_email || '').toLowerCase();
    if (!email) continue;
    if (!byEmail.has(email)) byEmail.set(email, c.author_name || email);
  }
  return Array.from(byEmail, ([email, name]) => ({ email, name }));
}

// Every author who has ever opened an MR, most-recent-activity first — the
// roster for the developer analytics page (not just people with something
// open right now, unlike listOpenMergeRequests's audience).
async function listAllAuthors() {
  const projectId = secret('GITLAB_PROJECT_ID');
  const q = 'state=all&order_by=created_at&sort=desc';
  const mrs = await apiFetchAll(
    projectId ? `/projects/${encodeURIComponent(projectId)}/merge_requests?${q}` : `/merge_requests?scope=all&${q}`,
    { maxPages: 5 }
  );
  const seen = new Map();
  for (const mr of mrs) {
    if (!mr.author || !mr.author.username) continue;
    if (!seen.has(mr.author.username)) seen.set(mr.author.username, { username: mr.author.username, name: mr.author.name || mr.author.username });
  }
  return Array.from(seen.values());
}

// Compares the X-Gitlab-Token header GitLab sends against WEBHOOK_SECRET.
// No secret configured means no webhook can ever be verified — fail closed.
function verifyWebhookToken(headerToken) {
  const expected = secret('WEBHOOK_SECRET');
  if (!expected) return false;
  return headerToken === expected;
}

module.exports = {
  getMergeRequestChanges,
  postNote,
  createDiscussion,
  listDiscussions,
  approveMergeRequest,
  getCurrentUser,
  listOpenMergeRequests,
  listAuthorMergeRequests,
  listBranchAuthors,
  listAllAuthors,
  verifyWebhookToken,
  gitlabBase,
};
