// The team table's row builder (lib/teamOverview.js). What matters here is
// that the row says what is wrong *right now* — the composite score belongs
// to the detail page, and a row that ranked people by score would send a
// manager to the wrong person on the wrong morning.
const test = require('node:test');
const assert = require('node:assert');
const teamOverview = require('../lib/teamOverview');

const NOW = Date.parse('2026-09-09T12:00:00Z');
const DAY = 86400000;
const HOUR = 3600000;

function analytics(over = {}) {
  return {
    delivery: { mrCount: 10, mergedCount: 8, stillOpenCount: 0, oldestOpenHours: null, medianOpenToMergeHours: 6 },
    jiraTasks: [],
    months: [],
    monthlyRows: [],
    autoScore: { score: 70, reason: '' },
    latestSprint: null,
    ...over,
  };
}

test('an unfinished task past its due date is overdue; one inside its deadline is not', () => {
  const tasks = [
    { statusCategory: 'indeterminate', dueDate: '2026-09-01' },       // due end of that day, so 7 full days over
    { statusCategory: 'indeterminate', dueDate: '2026-09-30' },       // not due yet
    { statusCategory: 'done', dueDate: '2026-08-01' },                // finished, late or not
    { statusCategory: 'indeterminate', dueDate: null },               // no date is not evidence
  ];
  const row = teamOverview.buildRow({ username: 'a', analytics: analytics({ jiraTasks: tasks }), now: NOW });
  assert.equal(row.overdueCount, 1);
  assert.equal(row.worstOverdueDays, 7, 'three overdue and one six weeks over are different mornings');
});

test('open merge requests are counted stale only past the threshold', () => {
  const mr = (hoursAgo, state) => ({ state, createdAt: new Date(NOW - hoursAgo * HOUR).toISOString() });
  const a = analytics({
    delivery: { mrCount: 4, mergedCount: 1, stillOpenCount: 3, oldestOpenHours: 300 },
    months: [{ tasks: [mr(300, 'opened'), mr(100, 'opened'), mr(10, 'opened'), mr(900, 'merged')] }],
  });
  const row = teamOverview.buildRow({ username: 'a', analytics: a, now: NOW });
  assert.equal(row.openMrs, 3);
  assert.equal(row.staleOpenMrs, 2, 'the 10-hour-old one is not stale, and a merged one is not open');
});

test('attention ranks a bad week over a middling score, not the other way round', () => {
  const calm = teamOverview.buildRow({
    username: 'calm', now: NOW,
    analytics: analytics({ autoScore: { score: 40 } }),
  });
  const struggling = teamOverview.buildRow({
    username: 'busy', now: NOW,
    analytics: analytics({
      autoScore: { score: 95 },
      jiraTasks: [{ statusCategory: 'indeterminate', dueDate: '2026-08-20' }],
    }),
  });
  assert.ok(struggling.attention > calm.attention,
    'a strong engineer with an overdue ticket must surface above a quiet one with a lower score');
  assert.equal(calm.attention, 0, 'nothing wrong means nothing to look at');
});

test('the trend compares the last two months that actually scored', () => {
  const rows = [
    { month: '2026-06', score: 50 },
    { month: '2026-07', score: null }, // nothing measurable — not a dip to zero
    { month: '2026-08', score: 65 },
  ];
  assert.deepEqual(teamOverview.trend(rows), { delta: 15, from: '2026-06', months: 2 });
  assert.equal(teamOverview.trend([{ month: '2026-08', score: 65 }]).delta, null, 'one month is not a trend');
});

test('the rollup sums what a manager can act on', () => {
  const rows = [
    teamOverview.buildRow({ username: 'a', now: NOW, analytics: analytics({ jiraTasks: [{ statusCategory: 'indeterminate', dueDate: '2026-09-01' }] }) }),
    teamOverview.buildRow({ username: 'b', now: NOW, analytics: analytics({ autoScore: { score: 80 } }) }),
  ];
  const sum = teamOverview.summarize(rows);
  assert.equal(sum.developers, 2);
  assert.equal(sum.overdue, 1);
  assert.equal(sum.scored, 2);
});
