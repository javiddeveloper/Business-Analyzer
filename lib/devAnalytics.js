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

// Checking round-trip status costs one extra GitLab API call per MR (the
// branch's commit authors) — capped so one prolific author's full history
// can't turn a single page load into hundreds of requests. MRs beyond the
// cap still count toward totals; their round-trip verdict is null ("not
// checked"), never false — "no" would be a claim we didn't actually verify.
const MAX_MRS_FOR_BRANCH_CHECK = 60;

function monthKey(dateStr) {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function mrKey(mr) {
  return `${mr.project_id}!${mr.iid}`;
}

async function buildDeveloperAnalytics(authorUsername, { since, until } = {}) {
  const mrs = await gitlab.listAuthorMergeRequests(authorUsername, { since, until });

  const checked = mrs.slice(0, MAX_MRS_FOR_BRANCH_CHECK);
  const branchAuthorsByMr = new Map();
  await Promise.all(checked.map(async (mr) => {
    try {
      const authors = await gitlab.listBranchAuthors(mr.project_id, mr.source_branch);
      branchAuthorsByMr.set(mrKey(mr), authors);
    } catch (e) {
      branchAuthorsByMr.set(mrKey(mr), null); // branch deleted / API error — unknown, not "no"
    }
  }));

  const records = mrs.map((mr) => {
    const key = mrKey(mr);
    const authors = branchAuthorsByMr.has(key) ? branchAuthorsByMr.get(key) : undefined;
    // GitLab answers 200 with an empty array for a ref_name that no longer
    // exists (the common case: a merged MR's source branch gets deleted)
    // rather than 404 — zero commits found means "no data", not "definitely
    // one tidy author", so it has to fall into the same unknown bucket as a
    // request that actually failed.
    const known = authors != null && authors.length > 0;
    const roundTrip = known ? authors.length > 1 : null;
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
      branchAuthorCount: known ? authors.length : null,
      branchAuthors: known ? authors.map((a) => a.name) : null,
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

module.exports = { buildDeveloperAnalytics, MAX_MRS_FOR_BRANCH_CHECK };
