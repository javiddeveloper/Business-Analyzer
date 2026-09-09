// Delivery metrics taken straight from GitLab — the half of the picture that
// depends on nobody filling in a field.
//
// Why these: in this org's real data, Time Spent is logged on ~47% of
// tickets, Story Points on none, and only 4 of one developer's 50 MRs have a
// review report. Every metric built on those rests on partial data. What
// GitLab records happens whether or not anyone cooperates — when the MR
// opened, when it merged, how many commits landed after it opened, how much
// discussion it drew — so these are complete for every MR, every time.
//
// Medians, not means. Cycle times are heavily skewed: one MR left open over a
// holiday drags a mean far past anything the team would recognise as typical.
// The p90 is reported beside the median so the tail stays visible rather than
// being smoothed away.

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const HOUR = 3600000;

function hoursBetween(fromIso, toIso) {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (isNaN(from) || isNaN(to) || to < from) return null;
  return (to - from) / HOUR;
}

function round1(n) {
  return n == null ? null : Math.round(n * 10) / 10;
}

// records: the per-MR objects devAnalytics builds.
function summarize(records = [], { now = Date.now() } = {}) {
  const merged = records.filter((r) => r.mergedAt && r.createdAt);
  const openToMerge = merged.map((r) => hoursBetween(r.createdAt, r.mergedAt)).filter((h) => h != null);

  // Cycle time proper: from the first commit on the branch to the merge, so
  // it counts the work, not just the time the MR sat in review. Only
  // available for MRs whose commits were fetched (devAnalytics does that for
  // the ones it has a review report for), so it is reported with its own
  // sample size rather than presented as covering everything.
  const withFirstCommit = merged.filter((r) => r.firstCommitAt);
  const cycle = withFirstCommit.map((r) => hoursBetween(r.firstCommitAt, r.mergedAt)).filter((h) => h != null);

  // Commits pushed after the MR was opened.
  //
  // This is deliberately NOT called rework. Measured against real history,
  // this team opens an MR within an hour or two of the first commit (!208
  // after 1.0h, !176 after 4.4h), so nearly all the work lands afterwards —
  // the number describes when they open MRs, not how much they had to redo.
  // The honest rework measure would be commits after the *first review*, and
  // that can't be computed here: across 50 MRs the median comment count is 0
  // and not one carries a note from anyone but its author, so GitLab holds no
  // record of review having happened at all.
  const withAfterOpen = records.filter((r) => r.commitsAfterOpen != null);
  const afterOpen = withAfterOpen.map((r) => r.commitsAfterOpen);

  // What share of MRs drew any discussion at all. Zero here is itself the
  // finding worth surfacing.
  const withNotes = records.filter((r) => typeof r.notesCount === 'number');
  const discussed = withNotes.filter((r) => r.notesCount > 0);

  const stillOpen = records.filter((r) => r.state === 'opened' && r.createdAt);
  const openAges = stillOpen.map((r) => hoursBetween(r.createdAt, new Date(now).toISOString())).filter((h) => h != null);

  const notes = records.map((r) => r.notesCount).filter((n) => typeof n === 'number');

  return {
    mrCount: records.length,
    mergedCount: merged.length,

    medianOpenToMergeHours: round1(median(openToMerge)),
    p90OpenToMergeHours: round1(percentile(openToMerge, 90)),
    openToMergeSample: openToMerge.length,

    medianCycleHours: round1(median(cycle)),
    p90CycleHours: round1(percentile(cycle, 90)),
    cycleSample: cycle.length,

    medianCommitsAfterOpen: round1(median(afterOpen)),
    afterOpenSample: afterOpen.length,

    discussedPct: withNotes.length ? Math.round(100 * (discussed.length / withNotes.length)) : null,
    discussedCount: discussed.length,
    discussedSample: withNotes.length,

    stillOpenCount: stillOpen.length,
    medianOpenAgeHours: round1(median(openAges)),
    oldestOpenHours: round1(openAges.length ? Math.max(...openAges) : null),

    medianNotes: round1(median(notes)),
    notesSample: notes.length,
  };
}

// Hours are the unit these are computed in, but nobody reads "412 ساعت".
function humanHours(hours) {
  if (hours == null) return '—';
  if (hours < 1) return `${Math.round(hours * 60)} دقیقه`;
  if (hours < 48) return `${Math.round(hours * 10) / 10} ساعت`;
  const days = hours / 24;
  return days < 14 ? `${Math.round(days * 10) / 10} روز` : `${Math.round(days)} روز`;
}

module.exports = { summarize, median, percentile, humanHours, hoursBetween };
