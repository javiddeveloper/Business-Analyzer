// Thin GitLab REST (v4) client: read an MR's diff, list open MRs, post a note,
// check the connection, and verify an inbound webhook token.
const { secret } = require('./ai_bridge');

function gitlabBase() {
  return (secret('GITLAB_URL') || 'https://gitlab.com').replace(/\/$/, '');
}

// Plain fetch has no timeout — a single stalled connection (this project has
// seen both ci.tamin.ir and the local model proxy go quiet mid-request more
// than once this session) would otherwise hang forever. That's tolerable for
// one call, but the developer-analytics page fires dozens of these in
// parallel (one repository/commits lookup per MR) — one hung socket there
// would block the entire page indefinitely instead of just being one slow
// or failed data point among many.
const DEFAULT_TIMEOUT_MS = 15000;

async function apiFetch(pathname, options = {}) {
  const url = `${gitlabBase()}/api/v4${pathname}`;
  const headers = Object.assign(
    { 'PRIVATE-TOKEN': secret('GITLAB_TOKEN'), 'Content-Type': 'application/json' },
    options.headers || {}
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { ...options, headers, signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`GitLab API timeout after ${(options.timeoutMs || DEFAULT_TIMEOUT_MS) / 1000}s: ${pathname}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
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

// POST /projects/:id/repository/commits — writes one file straight onto a
// branch, in a single commit, without touching any local checkout.
//
// Deliberately the API rather than `git commit && git push` from
// PROJECT_PATH: that checkout sits on whatever branch someone last worked
// on, so committing there would put the file on the wrong branch and could
// sweep up unrelated working-tree changes on the way. (The agent's worktree
// is closer — it is checked out at the MR's head — but it is detached, and
// pushing a detached HEAD onto somebody else's MR branch races any push
// they make meanwhile.) One API call targets exactly the branch asked for,
// atomically, and works identically on the diff-only path where there is no
// worktree at all.
//
// `action` has to match reality: GitLab answers 400 on "create" for a path
// that exists and on "update" for one that doesn't, so the caller passes
// which one it means (see fileExistsOnBranch).
function commitFile(projectId, { branch, filePath, content, message, action = 'create' }) {
  return apiFetch(`/projects/${encodeURIComponent(projectId)}/repository/commits`, {
    method: 'POST',
    body: JSON.stringify({
      branch,
      commit_message: message,
      actions: [{ action, file_path: filePath, content }],
    }),
  });
}

// Does this path already exist on that branch? Answers the create/update
// question above. A 404 is the expected "no" — anything else is a real
// failure and is thrown, because silently treating an outage as "not there"
// would turn into a create that then fails as a duplicate.
async function fileExistsOnBranch(projectId, branch, filePath) {
  try {
    await apiFetch(
      `/projects/${encodeURIComponent(projectId)}/repository/files/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(branch)}`
    );
    return true;
  } catch (e) {
    if (e.status === 404) return false;
    throw e;
  }
}

// GET /user — used purely as a connection/credential check for the dashboard's
// status badge, since it's the cheapest call that actually proves the token works.
function getCurrentUser(options) {
  return apiFetch('/user', options);
}

// Open MRs to show as tabs, scoped to one project — the dashboard now works
// across several configured projects (lib/projects.js), so the caller always
// says which one; omitting projectId falls back to secrets.env's single
// GITLAB_PROJECT_ID (or every open MR the token can see, scope=all — GitLab's
// default scope is created_by_me, which would hide MRs opened by teammates)
// for callers/tests that predate multi-project support.
//
// Ordered oldest-created-first on purpose: the team's merge order follows
// creation order, so the dashboard, auto-review, and the auto-approve
// ordering gate (jobs.js's mergeOrderGate) all need to see the same order to
// agree on "which MRs come before this one".
function listOpenMergeRequests(projectId) {
  const id = projectId || secret('GITLAB_PROJECT_ID');
  const q = 'state=opened&order_by=created_at&sort=asc&per_page=50';
  return id
    ? apiFetch(`/projects/${encodeURIComponent(id)}/merge_requests?${q}`)
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
// projectId is now explicit (a caller building cross-project analytics calls
// this once per configured project); omitted falls back to secrets.env.
function listAuthorMergeRequests(authorUsername, projectId, { since, until } = {}) {
  const id = projectId || secret('GITLAB_PROJECT_ID');
  const params = new URLSearchParams({ state: 'all', order_by: 'created_at', sort: 'asc', author_username: authorUsername });
  if (since) params.set('created_after', since);
  if (until) params.set('created_before', until);
  const q = params.toString();
  return apiFetchAll(
    id ? `/projects/${encodeURIComponent(id)}/merge_requests?${q}` : `/merge_requests?scope=all&${q}`
  );
}

// Distinct commit authors ON THIS MR SPECIFICALLY — the basis for the
// "round trip" signal (more than one person committing means someone else
// had to step in). This must be /merge_requests/:iid/commits, not
// /repository/commits?ref_name=<branch>: the latter returns everything
// reachable from the branch tip, which for a branch created off develop
// includes the *entire* history merged into develop before it — every other
// developer's every past MR. That made round-trip fire on almost every MR
// regardless of who actually touched it (confirmed on MR !97: ref_name
// history showed 8 different people; the MR's own commits show exactly one:
// its actual author). The MR-commits endpoint also still works after the
// source branch is deleted (the common post-merge state), unlike a
// ref_name lookup — so this incidentally removed most of what used to be
// reported as "unknown branch".
async function listMergeRequestCommitAuthors(projectId, mrIid) {
  const commits = await apiFetchAll(
    `/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/commits`,
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

// Commit counts per author on one MR — what the review report needs to say
// "12 commits, 3 of them from someone other than the author". The authors
// list above answers "who touched this" but deliberately dedupes, so it
// can't count; this keeps the raw per-author tally.
async function getMergeRequestCommitStats(projectId, mrIid) {
  const commits = await apiFetchAll(
    `/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/commits`,
    { maxPages: 3 }
  );
  const byEmail = new Map();
  const times = [];
  for (const c of commits) {
    const email = (c.author_email || '').toLowerCase();
    const key = email || (c.author_name || 'unknown');
    const entry = byEmail.get(key) || { email, name: c.author_name || email, count: 0 };
    entry.count++;
    byEmail.set(key, entry);
    // committed_date, not authored_date: a rebase rewrites the author date,
    // so authored_date can predate the branch by weeks and would turn a
    // one-day MR into a one-month cycle time.
    const at = Date.parse(c.committed_date || c.created_at || '');
    if (!isNaN(at)) times.push(at);
  }
  times.sort((a, b) => a - b);
  return {
    total: commits.length,
    byAuthor: Array.from(byEmail.values()).sort((a, b) => b.count - a.count),
    // Dates ride along because callers already paying for this request want
    // cycle time from them — a second call for the same commits would be
    // pure waste.
    firstAt: times.length ? new Date(times[0]).toISOString() : null,
    lastAt: times.length ? new Date(times[times.length - 1]).toISOString() : null,
    times,
  };
}

// When someone other than the author first said something on this MR — the
// start of review. Needed because "commits after the MR opened" turned out to
// measure this team's workflow rather than rework: they open MRs within an
// hour or two of the first commit, so nearly all the work lands afterwards.
// Commits after the *first review* is the number that actually says "had to
// go back and change it".
//
// System notes are skipped: GitLab records label changes, assignments and
// pushes as notes too, and none of those are review.
async function getFirstReviewAt(projectId, mrIid, authorUsername) {
  const notes = await apiFetchAll(
    `/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/notes?sort=asc&order_by=created_at`,
    { maxPages: 2 }
  );
  const author = String(authorUsername || '').toLowerCase();
  for (const n of notes) {
    if (n.system) continue;
    const by = String((n.author && n.author.username) || '').toLowerCase();
    if (by && by !== author) return n.created_at;
  }
  return null;
}

// GitLab access levels: 10 Guest, 20 Reporter, 30 Developer, 40 Maintainer,
// 50 Owner. The analytics roster is meant for people being reviewed, not
// whoever happens to manage the project — a Maintainer/Owner is there to run
// things, not to be scored on round-trip commits.
const DEVELOPER_ACCESS_LEVEL = 30;

// project members, direct + inherited from a parent group — only meaningful
// for a real project id (roles are a project-scoped concept; there's no
// single membership list across "every project this token can see").
function listProjectMembers(projectId) {
  const id = projectId || secret('GITLAB_PROJECT_ID');
  if (!id) return Promise.resolve(null);
  return apiFetchAll(`/projects/${encodeURIComponent(id)}/members/all`);
}

// Every author who has ever opened an MR in this project, most-recent-
// activity first — the roster for the developer analytics page (not just
// people with something open right now, unlike listOpenMergeRequests's
// audience) — filtered down to actual Developer-role members. Without a
// project id, GitLab has no single cross-project membership list to filter
// by, so every author is returned unfiltered (documented in the README).
async function listAllAuthors(projectId) {
  const id = projectId || secret('GITLAB_PROJECT_ID');
  const q = 'state=all&order_by=created_at&sort=desc';
  const mrs = await apiFetchAll(
    id ? `/projects/${encodeURIComponent(id)}/merge_requests?${q}` : `/merge_requests?scope=all&${q}`,
    { maxPages: 5 }
  );
  const seen = new Map();
  for (const mr of mrs) {
    if (!mr.author || !mr.author.username) continue;
    if (!seen.has(mr.author.username)) seen.set(mr.author.username, { username: mr.author.username, name: mr.author.name || mr.author.username });
  }
  const authors = Array.from(seen.values());

  const members = await listProjectMembers(id);
  if (members == null) return authors; // no project id — can't determine roles, so no filter applied
  const developerUsernames = new Set(members.filter((m) => m.access_level === DEVELOPER_ACCESS_LEVEL).map((m) => m.username));
  return authors.filter((a) => developerUsernames.has(a.username));
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
  commitFile,
  fileExistsOnBranch,
  getCurrentUser,
  listOpenMergeRequests,
  listAuthorMergeRequests,
  listMergeRequestCommitAuthors,
  getMergeRequestCommitStats,
  getFirstReviewAt,
  listProjectMembers,
  listAllAuthors,
  verifyWebhookToken,
  gitlabBase,
};
