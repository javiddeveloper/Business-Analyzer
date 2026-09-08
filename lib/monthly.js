// Per-month performance rows — the shape the Excel export and the dashboard
// chart both read from, so the spreadsheet and the screen can never tell
// different stories about the same month.
//
// Each month is scored with the very same devScore.compute() the overall
// number uses, just fed that month's slice. That matters: a monthly column
// computed by a second, slightly different formula is how a report ends up
// disagreeing with the page it was exported from.
const devScore = require('./devScore');

function monthKey(iso) {
  return iso ? String(iso).slice(0, 7) : null;
}

// Which month does a task belong to? The month it was finished, if it was —
// otherwise the month it last moved. Attributing an unfinished task to its
// creation month would park months-old work in a month nobody is looking at.
function taskMonth(task) {
  return monthKey(task.resolvedAt) || monthKey(task.updated) || null;
}

// analytics: the GitLab-derived object (months[], reportedMRs, …)
// jiraTasks:  this developer's Jira issues, already enriched
// reviews:    this tool's own review records for them
function buildMonthlyRows({ analytics = {}, jiraTasks = [], reviews = [], now = Date.now() } = {}) {
  const months = new Map();

  const ensure = (key) => {
    if (!key) return null;
    if (!months.has(key)) {
      months.set(key, {
        month: key, mrCount: 0, roundTripCount: 0, noReportCount: 0,
        tasks: [], reviews: [],
      });
    }
    return months.get(key);
  };

  for (const m of analytics.months || []) {
    const row = ensure(m.month);
    if (!row) continue;
    row.mrCount = m.mrCount || 0;
    row.roundTripCount = m.roundTripCount || 0;
    row.noReportCount = m.noReportCount || 0;
  }
  for (const t of jiraTasks) {
    const row = ensure(taskMonth(t));
    if (row) row.tasks.push(t);
  }
  for (const r of reviews) {
    const row = ensure(monthKey(new Date(r.at).toISOString()));
    if (row) row.reviews.push(r);
  }

  return Array.from(months.values())
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((row) => {
      const done = row.tasks.filter((t) => t.statusCategory === 'done');
      // Totals cover every task that records the value at all, so each
      // column is "the sum of what is recorded" and stands on its own.
      const estimateHours = row.tasks.reduce((s, t) => s + (t.estimateHours || 0), 0);
      const spentHours = row.tasks.reduce((s, t) => s + (t.spentHours || 0), 0);
      // Drift can only be measured where both numbers exist — often a small
      // subset, since under half the tickets log time. Comparing the two
      // totals above instead would read as a huge overrun/underrun that is
      // really just missing worklogs, so the basis is reported alongside it.
      const withBoth = row.tasks.filter((t) => t.estimateHours > 0 && t.spentHours > 0);
      const estimatedOfBoth = withBoth.reduce((s, t) => s + t.estimateHours, 0);
      const spentOfBoth = withBoth.reduce((s, t) => s + t.spentHours, 0);

      // Scored on this month's slice, with the *reviewed* MR counts for that
      // month rather than the all-time totals, so a good month can't be
      // dragged down by a bad quarter.
      const reportedThisMonth = Math.max(0, row.mrCount - row.noReportCount);
      const score = devScore.compute({
        tasks: row.tasks,
        analytics: { reportedMRs: reportedThisMonth, roundTripMRs: row.roundTripCount },
        reviews: row.reviews,
        // Recency is a "right now" measure; carrying it into a historical
        // month would just score every past month as stale. Left out, and
        // its weight redistributes like any other absent component.
        lastActivityMs: null,
        now,
      });

      return {
        month: row.month,
        mrCount: row.mrCount,
        roundTripCount: row.roundTripCount,
        taskCount: row.tasks.length,
        doneCount: done.length,
        estimateHours: Math.round(estimateHours * 10) / 10,
        spentHours: Math.round(spentHours * 10) / 10,
        estimateDriftPct: estimatedOfBoth > 0
          ? Math.round(((spentOfBoth - estimatedOfBoth) / estimatedOfBoth) * 100)
          : null,
        driftBasis: withBoth.length,
        reviewCount: row.reviews.length,
        score: score.score,
        components: Object.fromEntries(score.components.map((c) => [c.key, c.score])),
      };
    });
}

// Column layout shared by the Excel sheet and anything else that renders
// these rows, so a column added here shows up everywhere at once.
const COLUMNS = [
  { key: 'month', label: 'ماه' },
  { key: 'score', label: 'امتیاز کل' },
  { key: 'mrCount', label: 'تعداد MR' },
  { key: 'roundTripCount', label: 'رفت‌وبرگشت' },
  { key: 'taskCount', label: 'تعداد تسک' },
  { key: 'doneCount', label: 'تسک‌های Done' },
  { key: 'estimateHours', label: 'مجموع تخمین (ساعت)' },
  { key: 'spentHours', label: 'زمان ثبت‌شده (ساعت)' },
  { key: 'estimateDriftPct', label: 'انحراف تخمین ٪' },
  { key: 'driftBasis', label: 'تسک‌های پایه‌ی انحراف' },
  { key: 'reviewCount', label: 'تعداد ریویو' },
  { key: 'c_estimateAccuracy', label: 'نمره‌ی دقت تخمین' },
  { key: 'c_onTime', label: 'نمره‌ی تحویل به‌موقع' },
  { key: 'c_codeQuality', label: 'نمره‌ی کیفیت کد' },
  { key: 'c_reworkFree', label: 'نمره‌ی بدون رفت‌وبرگشت' },
  { key: 'c_completion', label: 'نمره‌ی تکمیل تسک‌ها' },
];

function cellValue(row, key) {
  if (key.startsWith('c_')) {
    const v = row.components[key.slice(2)];
    return v == null ? '' : v;
  }
  const v = row[key];
  return v == null ? '' : v;
}

function toSheetRows(rows) {
  return [COLUMNS.map((c) => c.label), ...rows.map((r) => COLUMNS.map((c) => cellValue(r, c.key)))];
}

module.exports = { buildMonthlyRows, COLUMNS, toSheetRows, taskMonth };
