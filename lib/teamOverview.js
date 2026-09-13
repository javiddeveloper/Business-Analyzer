// One row per developer for the team table — the view a manager opens first.
//
// The individual analytics page answers "how is this person doing"; nobody
// could ask "what is my team doing right now" without clicking through
// everyone one at a time and holding four pages in their head. This flattens
// one developer's analytics payload into the handful of numbers that decide
// where a manager looks next, and nothing else.
//
// The selection rule for what belongs here: it has to change what someone
// does today. A person's estimate-accuracy score is worth knowing at review
// time, not at 9am — so the score comes along as one number and its
// breakdown stays on the detail page. An overdue ticket or an MR that has
// been open nine days is the opposite: it is the reason to open the page.
const devScore = require('./devScore');

const DAY = 86400000;

// An MR still open this long is worth a manager's attention. Measured
// against this org's own history (2026-09-09): median time from opening an
// MR to merging it is 4-26 hours across the four developers, so three days
// open is already far outside how this team normally works — it is not an
// arbitrary round number.
const STALE_OPEN_MR_HOURS = 72;

function dueMs(task) {
  return task.dueDate ? new Date(`${task.dueDate}T23:59:59`).getTime() : null;
}

function isDone(task) {
  return task.statusCategory === 'done';
}

// Past its due date and still not finished. A task inside its deadline is
// not late, and an unfinished task with no due date at all is not evidence
// of anything — both stay out.
function isOverdue(task, now) {
  const due = dueMs(task);
  return !isDone(task) && due != null && now > due;
}

// How far past due the worst one is — "3 overdue" and "3 overdue, one of
// them by six weeks" are different mornings.
function worstOverdueDays(tasks, now) {
  let worst = 0;
  for (const t of tasks) {
    if (!isOverdue(t, now)) continue;
    worst = Math.max(worst, Math.floor((now - dueMs(t)) / DAY));
  }
  return worst || null;
}

// Where the score is heading, from the same monthly rows the chart and the
// spreadsheet use. Only months that actually scored count: a month with no
// measurable data is not a dip to zero.
function trend(monthlyRows) {
  const scored = (monthlyRows || []).filter((r) => r.score != null);
  if (scored.length < 2) return { delta: null, from: null, months: scored.length };
  const last = scored[scored.length - 1];
  const prev = scored[scored.length - 2];
  return { delta: last.score - prev.score, from: prev.month, months: scored.length };
}

// One ranking number for "who needs looking at first", so the table has a
// defensible default order instead of alphabetical-by-accident.
//
// Deliberately built only from things that are *wrong right now* — overdue
// work, merge requests going stale, finished work with no time logged —
// rather than from the composite score. A strong engineer having a bad week
// should surface here; a quiet week from someone with a middling score
// should not.
function attention(row) {
  return (row.overdueCount || 0) * 10
    + (row.worstOverdueDays || 0) * 0.5
    + (row.staleOpenMrs || 0) * 6
    + (row.missingWorklogCount || 0) * 2
    + (row.blockedNoMr || 0) * 3;
}

// Merge requests this person has left open past STALE_OPEN_MR_HOURS. Counted
// from the per-MR records rather than the delivery summary, which only knows
// the age of the single oldest one.
function countStaleOpenMrs(analytics, now) {
  let n = 0;
  for (const m of (analytics && analytics.months) || []) {
    for (const mr of m.tasks || []) {
      if (mr.state !== 'opened' || !mr.createdAt) continue;
      if ((now - Date.parse(mr.createdAt)) / 3600000 > STALE_OPEN_MR_HOURS) n++;
    }
  }
  return n;
}

// analytics: exactly what loadDeveloperAnalytics returns for this person.
// The tasks worth putting in front of someone, tagged with why. The team
// row otherwise carries only counts, and a count nobody can click is a count
// nobody acts on — the home page's task board is built from these.
//
// Capped per person: a roster of four with a hundred tickets each would put
// a payload nobody reads through the browser for a list nobody scrolls. The
// cap is applied after sorting by urgency, so what survives is the part that
// matters.
const TASKS_PER_DEVELOPER = 25;

// One task can be several kinds of problem at once (overdue *and* missing a
// worklog), so reasons are a list, not a category.
function taskReasons(task, now) {
  const reasons = [];
  if (isOverdue(task, now)) reasons.push('overdue');
  if (devScore.isReviewOrDone(task) && !(task.spentHours > 0)) reasons.push('no-worklog');
  if (task.statusCategory === 'indeterminate' && !task.hasMr) reasons.push('no-mr');
  return reasons;
}

function noteworthyTasks({ username, name, analytics, now }) {
  const tasks = (analytics && analytics.jiraTasks) || [];
  const out = [];
  for (const t of tasks) {
    const reasons = taskReasons(t, now);
    // Everything still open is listed even without a problem — "what is on
    // the team's plate" is the question, and a clean in-progress ticket is
    // still on the plate.
    const open = t.statusCategory !== 'done';
    if (!reasons.length && !open) continue;
    out.push({
      key: t.key,
      summary: t.summary || '',
      status: t.status || null,
      statusCategory: t.statusCategory || null,
      url: t.url || null,
      dueDate: t.dueDate || null,
      estimateHours: t.estimateHours == null ? null : t.estimateHours,
      spentHours: t.spentHours == null ? null : t.spentHours,
      sprint: t.sprint || null,
      project: t.project || null,
      hasMr: !!t.hasMr,
      mrs: Array.isArray(t.mrs) ? t.mrs.slice(0, 3) : [],
      overdueDays: isOverdue(t, now) ? Math.floor((now - dueMs(t)) / DAY) : null,
      reasons,
      owner: username,
      ownerName: name || username,
    });
  }
  // Most overdue first, then anything else flagged, then the rest.
  out.sort((a, b) => {
    const ao = a.overdueDays == null ? -1 : a.overdueDays;
    const bo = b.overdueDays == null ? -1 : b.overdueDays;
    if (ao !== bo) return bo - ao;
    return b.reasons.length - a.reasons.length;
  });
  return out.slice(0, TASKS_PER_DEVELOPER);
}

function buildRow({ username, name, analytics, now = Date.now() }) {
  const d = (analytics && analytics.delivery) || {};
  const tasks = (analytics && analytics.jiraTasks) || [];
  const sprint = (analytics && analytics.latestSprint) || null;
  const score = (analytics && analytics.autoScore) || {};

  const inProgress = tasks.filter((t) => t.statusCategory === 'indeterminate');
  const overdue = tasks.filter((t) => isOverdue(t, now));
  const missingWorklog = tasks.filter((t) => devScore.isReviewOrDone(t) && !(t.spentHours > 0));
  // Work that has moved past To Do but has no merge request anywhere — the
  // one thing GitLab alone can never show, and the usual shape of "it's
  // nearly done" that has not been touched in a week.
  const blockedNoMr = inProgress.filter((t) => !t.hasMr);

  const row = {
    username,
    name: name || username,
    score: score.score == null ? null : score.score,
    scoreReason: score.reason || '',
    trend: trend(analytics && analytics.monthlyRows),

    // Right now
    openMrs: d.stillOpenCount || 0,
    oldestOpenHours: d.oldestOpenHours == null ? null : d.oldestOpenHours,
    staleOpenMrs: countStaleOpenMrs(analytics, now),
    inProgressCount: inProgress.length,
    blockedNoMr: blockedNoMr.length,

    // Not going well
    overdueCount: overdue.length,
    worstOverdueDays: worstOverdueDays(tasks, now),
    missingWorklogCount: missingWorklog.length,

    // Delivered
    taskCount: tasks.length,
    doneCount: tasks.filter(isDone).length,
    mrCount: d.mrCount || 0,
    mergedCount: d.mergedCount || 0,
    medianOpenToMergeHours: d.medianOpenToMergeHours == null ? null : d.medianOpenToMergeHours,

    sprintName: sprint ? sprint.name : null,
    sprintScore: sprint ? sprint.score : null,
    sprintDone: sprint ? sprint.doneCount : null,
    sprintTasks: sprint ? sprint.taskCount : null,

    lastActivityMs: (analytics && analytics.lastActivityMs) || null,
    jiraConfigured: !!(analytics && analytics.jiraConfigured),
  };
  row.attention = Math.round(attention(row) * 10) / 10;
  row.tasks = noteworthyTasks({ username, name, analytics, now });
  return row;
}

// Team-level rollup. Sums where a sum means something (open work, overdue
// tickets); a median-of-medians is not reported, because it is not a number
// anybody can act on.
function summarize(rows) {
  const withScore = rows.filter((r) => r.score != null);
  return {
    developers: rows.length,
    scored: withScore.length,
    medianScore: withScore.length
      ? Math.round(withScore.map((r) => r.score).sort((a, b) => a - b)[withScore.length >> 1])
      : null,
    openMrs: rows.reduce((a, r) => a + r.openMrs, 0),
    staleOpenMrs: rows.reduce((a, r) => a + r.staleOpenMrs, 0),
    inProgress: rows.reduce((a, r) => a + r.inProgressCount, 0),
    overdue: rows.reduce((a, r) => a + r.overdueCount, 0),
    missingWorklog: rows.reduce((a, r) => a + r.missingWorklogCount, 0),
    blockedNoMr: rows.reduce((a, r) => a + r.blockedNoMr, 0),
    done: rows.reduce((a, r) => a + r.doneCount, 0),
    tasks: rows.reduce((a, r) => a + r.taskCount, 0),
  };
}

module.exports = { buildRow, summarize, attention, trend, isOverdue, worstOverdueDays, countStaleOpenMrs, noteworthyTasks, taskReasons, STALE_OPEN_MR_HOURS, TASKS_PER_DEVELOPER };
