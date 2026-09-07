// Builds the "Developer Analytics" page's data: every MR a person has ever
// opened (not just currently-open ones), whether each one looks like it
// needed someone else's help (the "round trip" signal), and both grouped by
// month for the chart/task-list.
//
// Deliberately returns per-MR records with room to grow — a new metric later
// (review-finding counts, time-to-merge, whatever point 7 turns into) is
// just another field on each record; the month-grouping and chart consume
// whatever fields exist without needing to change shape.
const gitlab = require('./gitlab');
const task = require('./task');

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

async function buildDeveloperAnalytics(authorUsername, { since, until } = {}) {
  const mrs = await gitlab.listAuthorMergeRequests(authorUsername, { since, until });

  const checked = mrs.slice(0, MAX_MRS_FOR_BRANCH_CHECK);
  const commitAuthorsByMr = new Map();
  await Promise.all(checked.map(async (mr) => {
    try {
      const authors = await gitlab.listMergeRequestCommitAuthors(mr.project_id, mr.iid);
      commitAuthorsByMr.set(mrKey(mr), authors);
    } catch (e) {
      commitAuthorsByMr.set(mrKey(mr), null); // API error — unknown, not "no"
    }
  }));

  const records = mrs.map((mr) => {
    const key = mrKey(mr);
    const authors = commitAuthorsByMr.has(key) ? commitAuthorsByMr.get(key) : undefined;
    // Zero commits on a real MR would be a GitLab oddity, not a fact worth
    // trusting — treated the same as "couldn't check" rather than "clean".
    const known = authors != null && authors.length > 0;
    const others = known ? authors.filter((a) => !isMrAuthor(mr.author || {}, { author_email: a.email, author_name: a.name })) : [];
    const roundTrip = known ? others.length > 0 : null;
    return {
      iid: mr.iid,
      projectId: mr.project_id,
      title: mr.title,
      state: mr.state,
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      targetIsDevelop: mr.target_branch === 'develop',
      task: task.extractTask(mr.source_branch) || task.extractTask(mr.title),
      createdAt: mr.created_at,
      mergedAt: mr.merged_at || null,
      webUrl: mr.web_url,
      commitAuthorCount: known ? authors.length : null,
      otherAuthors: known ? others.map((a) => a.name) : null,
      roundTrip,
    };
  });

  // Grouped by calendar month of creation. A new per-record field automatically
  // rides along in `tasks` here with no change needed to this grouping step.
  const monthMap = new Map();
  for (const r of records) {
    const key = monthKey(r.createdAt);
    if (!monthMap.has(key)) monthMap.set(key, { month: key, mrCount: 0, roundTripCount: 0, uncheckedCount: 0, tasks: [] });
    const bucket = monthMap.get(key);
    bucket.mrCount++;
    if (r.roundTrip === true) bucket.roundTripCount++;
    if (r.roundTrip === null) bucket.uncheckedCount++;
    bucket.tasks.push(r);
  }
  const months = Array.from(monthMap.values()).sort((a, b) => a.month.localeCompare(b.month));

  return {
    author: authorUsername,
    totalMRs: mrs.length,
    roundTripMRs: records.filter((r) => r.roundTrip === true).length,
    uncheckedMRs: records.filter((r) => r.roundTrip === null).length,
    checkedCap: MAX_MRS_FOR_BRANCH_CHECK,
    months,
  };
}

module.exports = { buildDeveloperAnalytics, MAX_MRS_FOR_BRANCH_CHECK, isMrAuthor };
