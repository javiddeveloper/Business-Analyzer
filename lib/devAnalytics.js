// Builds the "Developer Analytics" page's data: every MR a person has ever
// opened across every configured project (lib/projects.js — the page is
// meant to judge a person, not one repo), whether each one looks like it
// needed someone else's help (the "round trip" signal), and both grouped by
// month for the chart/task-list.
//
// Deliberately returns per-MR records with room to grow — a new metric later
// (review-finding counts, time-to-merge, whatever point 7 turns into) is
// just another field on each record; the month-grouping and chart consume
// whatever fields exist without needing to change shape.
const fs = require('fs');
const gitlab = require('./gitlab');
const task = require('./task');
const projects = require('./projects');
const reportFile = require('./reportFile');
const { secret } = require('./ai_bridge');

// Checking round-trip status costs one extra GitLab API call per MR (its
// commit list) — capped so one prolific author's full history can't turn a
// single page load into hundreds of requests. MRs beyond the cap still count
// toward totals; their round-trip verdict is null ("not checked"), never
// false — "no" would be a claim we didn't actually verify.
const MAX_MRS_FOR_BRANCH_CHECK = 60;

function monthKey(dateStr) {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function mrKey(mr) {
  return `${mr.project_id}!${mr.iid}`;
}

// Is this commit plausibly the MR author's own work, or someone else's?
// GitLab's commits API only carries raw git author_name/author_email — not
// a GitLab user id — so identity has to be inferred. This org's accounts
// consistently email as `<username>@...` (verified against real commit
// history), so "the email's local part is the MR author's username" is a
// solid match; falling back to an exact display-name match covers the rest
// without needing to guess at partial/fuzzy name matching.
function isMrAuthor(mrAuthor, commit) {
  const emailLocal = String(commit.author_email || '').toLowerCase().split('@')[0];
  const username = String(mrAuthor.username || '').toLowerCase();
  if (username && emailLocal === username) return true;
  const name = String(mrAuthor.name || '').trim();
  return !!name && String(commit.author_name || '').trim() === name;
}

// The round-trip signal is only meaningful for an MR this tool actually
// reviewed — that's the point of asking "did someone else have to step in
// and fix it", and the only evidence of that here is our own
// review/MR-<iid>.md report existing in that project's local checkout. An
// MR nobody ever ran through coder-review (or whose project has no local
// path configured) gets no round-trip verdict at all, rather than one
// computed from a commit history nobody asked us to judge.
//
// projectId here must be the *configured* project id (the one used to fetch
// this MR — see configuredId below), not GitLab's own numeric project_id:
// GITLAB_PROJECT_ID is commonly set to the namespaced path form
// ("group/subgroup/repo"), which GitLab happily accepts as an :id in every
// API call but which never equals the numeric id GitLab reports back on the
// MR objects themselves. Falls back to secrets.env's single PROJECT_PATH,
// same safety net jobs.js's resolveProjectPath uses, for the common single-
// project setup where that lookup would otherwise never match.
function hasReviewReport(configuredProjectId, mrIid) {
  const projectPath = projects.getProjectPath(configuredProjectId) || secret('PROJECT_PATH');
  if (!projectPath) return false;
  try {
    return fs.existsSync(reportFile.reportPath(projectPath, mrIid));
  } catch (e) {
    return false;
  }
}

async function buildDeveloperAnalytics(authorUsername, { since, until } = {}) {
  const configuredProjects = projects.listProjects();
  // No project configured at all (fresh install, nothing in secrets.env or
  // the settings tab yet) — ask gitlab.js for whatever it can see without a
  // project id, same as before multi-project support existed.
  const projectIds = configuredProjects.length ? configuredProjects.map((p) => p.id) : [undefined];

  // Each MR is tagged with the *configured* project id it was fetched
  // under (not trusted to reverse-match against GitLab's numeric
  // project_id later — see hasReviewReport above for why those can differ).
  const mrLists = await Promise.all(projectIds.map((id) =>
    gitlab.listAuthorMergeRequests(authorUsername, id, { since, until }).then((list) => list.map((mr) => ({ mr, configuredId: id })))
  ));
  const entries = mrLists.flat();

  const eligibleForCheck = entries.filter((e) => hasReviewReport(e.configuredId, e.mr.iid));
  const checked = eligibleForCheck.slice(0, MAX_MRS_FOR_BRANCH_CHECK);
  const commitAuthorsByMr = new Map();
  await Promise.all(checked.map(async ({ mr }) => {
    try {
      const authors = await gitlab.listMergeRequestCommitAuthors(mr.project_id, mr.iid);
      commitAuthorsByMr.set(mrKey(mr), authors);
    } catch (e) {
      commitAuthorsByMr.set(mrKey(mr), null); // API error — unknown, not "no"
    }
  }));

  const records = entries.map(({ mr, configuredId }) => {
    const key = mrKey(mr);
    const reviewed = hasReviewReport(configuredId, mr.iid);
    const authors = commitAuthorsByMr.has(key) ? commitAuthorsByMr.get(key) : undefined;
    // Zero commits on a real MR would be a GitLab oddity, not a fact worth
    // trusting — treated the same as "couldn't check" rather than "clean".
    const known = authors != null && authors.length > 0;
    const others = known ? authors.filter((a) => !isMrAuthor(mr.author || {}, { author_email: a.email, author_name: a.name })) : [];
    // Not reviewed by us yet → no verdict, and deliberately distinct from
    // "reviewed but inconclusive" (branch deleted / past the API-call cap).
    const roundTrip = !reviewed ? null : (known ? others.length > 0 : null);
    const project = configuredProjects.find((p) => String(p.id) === String(configuredId));
    return {
      iid: mr.iid,
      projectId: mr.project_id,
      projectName: (project && project.name) || null,
      title: mr.title,
      state: mr.state,
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      targetIsDevelop: mr.target_branch === 'develop',
      task: task.extractTask(mr.source_branch) || task.extractTask(mr.title),
      createdAt: mr.created_at,
      mergedAt: mr.merged_at || null,
      webUrl: mr.web_url,
      hasReport: reviewed,
      commitAuthorCount: known ? authors.length : null,
      otherAuthors: known ? others.map((a) => a.name) : null,
      roundTrip,
    };
  });

  // Grouped by calendar month of creation, newest month first — that's the
  // order someone reviewing a person's recent work actually wants to read
  // it in; the chart below iterates the same array in the same order.
  const monthMap = new Map();
  for (const r of records) {
    const key = monthKey(r.createdAt);
    if (!monthMap.has(key)) monthMap.set(key, { month: key, mrCount: 0, roundTripCount: 0, uncheckedCount: 0, noReportCount: 0, tasks: [] });
    const bucket = monthMap.get(key);
    bucket.mrCount++;
    if (!r.hasReport) bucket.noReportCount++;
    else if (r.roundTrip === true) bucket.roundTripCount++;
    else if (r.roundTrip === null) bucket.uncheckedCount++;
    bucket.tasks.push(r);
  }
  for (const bucket of monthMap.values()) {
    bucket.tasks.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }
  const months = Array.from(monthMap.values()).sort((a, b) => b.month.localeCompare(a.month));

  return {
    author: authorUsername,
    totalMRs: entries.length,
    reportedMRs: records.filter((r) => r.hasReport).length,
    roundTripMRs: records.filter((r) => r.roundTrip === true).length,
    uncheckedMRs: records.filter((r) => r.hasReport && r.roundTrip === null).length,
    checkedCap: MAX_MRS_FOR_BRANCH_CHECK,
    months,
  };
}

module.exports = { buildDeveloperAnalytics, MAX_MRS_FOR_BRANCH_CHECK, isMrAuthor, hasReviewReport };
