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
function listOpenMergeRequests() {
  const projectId = secret('GITLAB_PROJECT_ID');
  const q = 'state=opened&order_by=updated_at&sort=desc&per_page=50';
  return projectId
    ? apiFetch(`/projects/${encodeURIComponent(projectId)}/merge_requests?${q}`)
    : apiFetch(`/merge_requests?scope=all&${q}`);
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
  verifyWebhookToken,
  gitlabBase,
};
