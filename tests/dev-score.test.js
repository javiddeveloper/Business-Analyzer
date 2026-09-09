// The composite score (lib/devScore.js). The properties that matter here are
// less about exact numbers than about the score being defensible: symmetric
// treatment of over/under-estimating, missing data never counting as zero,
// and a task still inside its deadline not being called late.
const test = require('node:test');
const assert = require('node:assert');
const devScore = require('../lib/devScore');

const DAY = 86400000;
const NOW = Date.parse('2026-09-08T12:00:00Z');

test('over- and under-estimating by the same factor are penalised equally', () => {
  const twiceAsLong = devScore.estimateTaskScore(10, 20);
  const halfAsLong = devScore.estimateTaskScore(10, 5);
  assert.equal(twiceAsLong, halfAsLong, 'otherwise padding an estimate would quietly score better than missing one');
  assert.equal(twiceAsLong, 50, 'a 2× miss lands at half marks');
  assert.equal(devScore.estimateTaskScore(10, 10), 100, 'spot on');
  assert.equal(devScore.estimateTaskScore(10, 40), 0, 'a 4× miss bottoms out');
});

test('estimate accuracy only counts tasks that have both an estimate and logged time', () => {
  const out = devScore.estimateAccuracy([
    { estimateHours: 10, spentHours: 10 },
    { estimateHours: 10, spentHours: null }, // no worklog — unknowable, not a zero
    { estimateHours: null, spentHours: 8 },
  ]);
  assert.equal(out.sampleSize, 1);
  assert.equal(out.score, 100);
});

test('estimate accuracy is null, not zero, when nobody logs time', () => {
  assert.equal(devScore.estimateAccuracy([{ estimateHours: 10, spentHours: null }]), null);
});

test('a task inside its deadline is not yet late; a resolved one is judged on when it resolved', () => {
  const tasks = [
    { dueDate: '2026-09-01', resolvedAt: '2026-08-30T10:00:00.000+0000' }, // early
    { dueDate: '2026-09-01', resolvedAt: '2026-09-05T10:00:00.000+0000' }, // 4 days late
    { dueDate: '2026-09-20', resolvedAt: null },                            // open, not due yet
    { dueDate: '2026-09-01', resolvedAt: null },                            // open and overdue
    { dueDate: null, resolvedAt: null },                                    // no due date at all
  ];
  const out = devScore.onTime(tasks, NOW);
  assert.equal(out.sampleSize, 3, 'the not-yet-due task and the one with no due date are both excluded');
  assert.equal(out.strictlyOnTime, 1);
});

// This team closes most tickets well after the due date, so a pass/fail test
// scored nearly everyone ~4 and could not tell anyone apart. Lateness is
// graded instead: still honest about the delay, but two days late and two
// months late are no longer the same answer.
test('lateness is graded, so being slightly late scores far above being months late', () => {
  assert.equal(devScore.lateTaskScore(0), 100);
  assert.equal(devScore.lateTaskScore(-5), 100, 'early is not extra credit, just on time');
  assert.equal(devScore.lateTaskScore(3), 90);
  assert.equal(devScore.lateTaskScore(15), 50);
  assert.equal(devScore.lateTaskScore(30), 0);
  assert.equal(devScore.lateTaskScore(200), 0, 'floors rather than going negative');

  const slightly = devScore.onTime([{ dueDate: '2026-09-06', resolvedAt: '2026-09-08T10:00:00.000+0000' }], NOW);
  const badly = devScore.onTime([{ dueDate: '2026-06-01', resolvedAt: '2026-09-08T10:00:00.000+0000' }], NOW);
  assert.ok(slightly.score > badly.score + 50, `graded lateness must separate these (${slightly.score} vs ${badly.score})`);
  assert.equal(badly.score, 0);
});

// A ticket that reached Review or Done with no logged hours is a hole in
// every other number: estimate accuracy can't see it, and the month's totals
// under-report the real effort. Scored on its own so "estimates are off" and
// "nobody logged time" stay separate problems.
test('time logging is scored only on tasks that actually reached Review or Done', () => {
  const out = devScore.timeLogging([
    { statusCategory: 'done', status: 'Done', spentHours: 5 },
    { statusCategory: 'done', status: 'Done', spentHours: null },
    { statusCategory: 'indeterminate', status: 'In Review', spentHours: null },
    { statusCategory: 'indeterminate', status: 'In Progress', spentHours: null },
    { statusCategory: 'new', status: 'To Do', spentHours: null },
  ]);
  assert.equal(out.sampleSize, 3, 'To Do and In Progress have no time to log yet');
  assert.equal(out.score, 33, '1 of 3 logged');
  assert.match(out.detail, /2 تسک بدون ثبت زمان/);

  assert.equal(devScore.isReviewOrDone({ statusCategory: 'new', status: 'To Do' }), false);
  assert.equal(devScore.isReviewOrDone({ statusCategory: 'indeterminate', status: 'In Review' }), true);
  assert.equal(devScore.isReviewOrDone({ statusCategory: 'done', status: 'Closed' }), true);
});

test('time logging is null, not zero, when nothing has reached Review or Done yet', () => {
  assert.equal(devScore.timeLogging([{ statusCategory: 'new', status: 'To Do', spentHours: null }]), null);
});

test('a component with no data drops out and its weight is shared, rather than scoring zero', () => {
  const tasks = [{ estimateHours: 10, spentHours: 10, dueDate: '2026-09-20', resolvedAt: null, statusCategory: 'done' }];
  const withQuality = devScore.compute({
    tasks, analytics: { reportedMRs: 4, roundTripMRs: 0 },
    reviews: [{ severityCounts: {} }], lastActivityMs: NOW - DAY, now: NOW,
  });
  const withoutQuality = devScore.compute({
    tasks, analytics: { reportedMRs: 4, roundTripMRs: 0 },
    reviews: [], lastActivityMs: NOW - DAY, now: NOW,
  });

  const q = withQuality.components.find((c) => c.key === 'codeQuality');
  const qGone = withoutQuality.components.find((c) => c.key === 'codeQuality');
  assert.ok(q.available && q.effectiveWeight > 0);
  assert.equal(qGone.available, false);
  assert.equal(qGone.effectiveWeight, 0);

  // Everything present scores 100 here, so dropping one perfect component
  // must leave the total at 100 — not drag it down.
  assert.equal(withQuality.score, 100);
  assert.equal(withoutQuality.score, 100, 'a missing input silently costing points would be the bug this guards');

  const estBefore = withQuality.components.find((c) => c.key === 'estimateAccuracy');
  const estAfter = withoutQuality.components.find((c) => c.key === 'estimateAccuracy');
  assert.ok(estAfter.effectiveWeight > estBefore.effectiveWeight, 'the dropped weight went to the components that do have data');
});

// A component backed by one data point must not swing the score as hard as
// one backed by a hundred — otherwise a single reviewed MR decides a fifth
// of someone's score.
test('thin evidence carries proportionally less weight', () => {
  assert.equal(devScore.confidence(0), 0);
  assert.ok(devScore.confidence(1) < 0.2, 'one sample is weak evidence');
  assert.equal(devScore.confidence(devScore.CONFIDENCE_K), 0.5, 'K samples = half weight');
  assert.ok(devScore.confidence(100) > 0.9);

  const base = {
    tasks: [{ estimateHours: 10, spentHours: 10, dueDate: '2026-09-20', resolvedAt: null, statusCategory: 'done' }],
    analytics: { reportedMRs: 4, roundTripMRs: 4 }, // rework 0/100
    lastActivityMs: NOW - DAY, now: NOW,
  };
  const oneBadReview = devScore.compute({ ...base, reviews: [{ severityCounts: { High: 4 } }] });
  const manyBadReviews = devScore.compute({ ...base, reviews: Array.from({ length: 40 }, () => ({ severityCounts: { High: 4 } })) });

  const thin = oneBadReview.components.find((c) => c.key === 'codeQuality');
  const thick = manyBadReviews.components.find((c) => c.key === 'codeQuality');
  assert.equal(thin.score, thick.score, 'same quality score…');
  // Effective weights are renormalized shares, so compare the ratio rather
  // than expecting the raw confidence gap (17% vs 89%) to survive intact.
  assert.ok(thick.effectiveWeight > thin.effectiveWeight * 2, `…but forty reviews weigh far more than one (${thin.effectiveWeight}% vs ${thick.effectiveWeight}%)`);
  assert.ok(oneBadReview.score > manyBadReviews.score, 'so one bad review hurts less than a sustained pattern');
});

test('effective weights always add up to 100% of what was actually used', () => {
  const out = devScore.compute({
    tasks: [{ estimateHours: 8, spentHours: 12, dueDate: '2026-09-01', resolvedAt: '2026-09-03T00:00:00Z', statusCategory: 'done' }],
    analytics: { reportedMRs: 10, roundTripMRs: 3 },
    reviews: [{ severityCounts: { Medium: 2 } }],
    lastActivityMs: NOW - 5 * DAY,
    now: NOW,
  });
  const sum = out.components.filter((c) => c.available).reduce((a, c) => a + c.effectiveWeight, 0);
  assert.ok(Math.abs(sum - 100) < 0.5, `weights should total ~100%, got ${sum}`);
  assert.ok(out.score > 0 && out.score < 100);
});

test('with nothing to go on the score is null rather than a made-up number', () => {
  const out = devScore.compute({ tasks: [], analytics: {}, reviews: [], lastActivityMs: null, now: NOW });
  assert.equal(out.score, null);
  assert.match(out.reason, /هیچ داده‌ای/);
});
