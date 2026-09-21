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

// Regression: buildRow's missingWorklogCount (and the 'no-worklog' reason
// noteworthyTasks tags a card with) used to check only isReviewOrDone, not
// devScore's own needsTimeLog — so a Story reaching Done with nothing logged
// on it (normal: the hours are logged on its sub-tasks) was flagged as a
// real problem here even though it never cost the person a single point in
// their actual score.
test('a done Story/Epic with no logged time is not counted as a missing worklog', () => {
  const tasks = [
    { statusCategory: 'done', type: 'Task', spentHours: 5 },
    { statusCategory: 'done', type: 'Story', spentHours: null },
    { statusCategory: 'done', type: 'Epic', spentHours: null },
    { statusCategory: 'done', type: 'Bug', spentHours: null }, // this one is a real miss
  ];
  const row = teamOverview.buildRow({ username: 'a', analytics: analytics({ jiraTasks: tasks }), now: NOW });
  assert.equal(row.missingWorklogCount, 1, 'only the Bug should count — the Story and Epic are containers, not evidence of a hole');
});

test("a done Story with no logged time does not get tagged 'no-worklog' among the noteworthy tasks", () => {
  const tasks = [
    { key: 'STORY-1', type: 'Story', statusCategory: 'done', spentHours: null, dueDate: null },
    { key: 'BUG-1', type: 'Bug', statusCategory: 'done', spentHours: null, dueDate: null },
  ];
  const row = teamOverview.buildRow({ username: 'a', analytics: analytics({ jiraTasks: tasks }), now: NOW });
  const story = row.tasks.find((t) => t.key === 'STORY-1');
  const bug = row.tasks.find((t) => t.key === 'BUG-1');
  // A done task with no reasons at all is dropped from the noteworthy list
  // entirely (see noteworthyTasks) — so under the old bug the Story would
  // have shown up here carrying 'no-worklog'; the fix means it never
  // qualifies as noteworthy in the first place.
  assert.equal(story, undefined, "a done Story with nothing else wrong must not be noteworthy — the old bug listed it for 'no-worklog'");
  assert.ok(bug && bug.reasons.includes('no-worklog'), 'a real task with no logged time is still flagged');
});
