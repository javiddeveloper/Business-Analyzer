// Thin GitLab REST (v4) client — just the three calls this product needs:
// read an MR's diff, post a note on it, and verify an inbound webhook token.
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

// Compares the X-Gitlab-Token header GitLab sends against WEBHOOK_SECRET.
// No secret configured means no webhook can ever be verified — fail closed.
function verifyWebhookToken(headerToken) {
  const expected = secret('WEBHOOK_SECRET');
  if (!expected) return false;
  return headerToken === expected;
}

module.exports = { getMergeRequestChanges, postNote, verifyWebhookToken };
