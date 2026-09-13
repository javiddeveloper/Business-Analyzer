// The two-axis C/L rating a maintainer leaves at the end of
// review/MR-<iid>.md, and what it does to the score.
const test = require('node:test');
const assert = require('node:assert');
const difficulty = require('../lib/difficulty');
const devScore = require('../lib/devScore');

test('both axes are read, and they are independent', () => {
  assert.deepEqual(difficulty.parseRating('C*** L**'), { complexity: 3, length: 2 });
  // A one-line change to a payment rule, and a rename across ninety files.
  assert.deepEqual(difficulty.parseRating('C**** L*'), { complexity: 4, length: 1 });
  assert.deepEqual(difficulty.parseRating('C* L*****'), { complexity: 1, length: 5 });
});

test('either axis may appear alone', () => {
  assert.deepEqual(difficulty.parseRating('L***'), { complexity: null, length: 3 });
  assert.deepEqual(difficulty.parseRating('C*****'), { complexity: 5, length: null });
});

// MR !227's file really ends this way, from before the C/L split existed.
test('a bare run of asterisks still reads as complexity', () => {
  assert.deepEqual(difficulty.parseRating('| 3 | 2026-09-13 | `e45c` | done |\n***'), { complexity: 3, length: null });
});

test('an explicit C rating wins over a trailing bare rule', () => {
  assert.deepEqual(difficulty.parseRating('C** L*\n***'), { complexity: 2, length: 1 });
});

test('the rating is taken from the end, not from prose describing the scale', () => {
  // The knowledge base explains the scale; a file quoting it must not be read
  // as rating itself that way. Only the tail is scanned, and later wins.
  const body = Array.from({ length: 40 }, () => 'C***** means genuinely hard').join('\n') + '\nC* L*';
  assert.deepEqual(difficulty.parseRating(body), { complexity: 1, length: 1 });
});

test('no marker means no rating — never a default of "easy"', () => {
  assert.equal(difficulty.parseRating('| 1 | date | sha | 6 items |'), null);
  assert.equal(difficulty.parseRating(''), null);
  assert.equal(difficulty.parseRating(null), null);
  assert.equal(difficulty.parseRating('---'), null, 'a markdown rule is not a rating');
});

// ---- what it does to the score ---------------------------------------------

test('big merge requests cost score, small ones do not', () => {
  assert.equal(difficulty.lengthScore(1), 100);
  assert.equal(difficulty.lengthScore(2), 100);
  assert.equal(difficulty.lengthScore(3), 70, 'L*** is the turning point');
  assert.equal(difficulty.lengthScore(4), 35);
  assert.equal(difficulty.lengthScore(5), 0, 'the case the rule exists to discourage');

  const small = devScore.mrSize([{ length: 1 }, { length: 2 }]);
  const huge = devScore.mrSize([{ length: 5 }, { length: 5 }]);
  assert.equal(small.score, 100);
  assert.equal(huge.score, 0);
  assert.match(huge.detail, /2 MR بزرگ/);
  assert.match(small.detail, /هیچ MR بزرگی نیست/);
});

test('MRs with no L rating are not assumed small', () => {
  assert.equal(devScore.mrSize([]), null);
  assert.equal(devScore.mrSize([{ complexity: 3 }]), null, 'a C rating alone says nothing about size');
  const mixed = devScore.mrSize([{ length: 5 }, { complexity: 2 }]);
  assert.equal(mixed.sampleSize, 1, 'only the rated one counts');
});

const BASE = {
  tasks: [{ statusCategory: 'done', status: 'Done', estimateHours: 10, spentHours: 10, dueDate: '2026-09-20', resolvedAt: null }],
  analytics: { reportedMRs: 4, roundTripMRs: 0 },
  reviews: [],
  now: Date.parse('2026-09-13T12:00:00Z'),
};

test('an unrated developer is scored exactly as before — the rating adds nothing either way', () => {
  const out = devScore.compute({ ...BASE, ratings: [] });
  assert.equal(out.complexityAdjustment, 0);
  assert.equal(out.score, out.baseScore);
  assert.equal(out.components.find((c) => c.key === 'mrSize').available, false);
});

test('shipping only huge MRs pulls the score down', () => {
  const small = devScore.compute({ ...BASE, ratings: [{ length: 1 }, { length: 2 }] });
  const huge = devScore.compute({ ...BASE, ratings: [{ length: 5 }, { length: 5 }] });
  assert.ok(huge.score < small.score - 20, `huge MRs must cost real score (${huge.score} vs ${small.score})`);
});

// Complexity is not an achievement on its own — being handed a hard ticket is
// not a result — so it nudges rather than scoring, and the nudge is bounded.
test('complexity adjusts what delivered work is worth, within a bound', () => {
  const hard = devScore.compute({ ...BASE, ratings: [{ complexity: 5, length: 1 }] });
  const easy = devScore.compute({ ...BASE, ratings: [{ complexity: 1, length: 1 }] });
  const ordinary = devScore.compute({ ...BASE, ratings: [{ complexity: 2, length: 1 }] });

  assert.ok(hard.complexityAdjustment > 0);
  assert.ok(easy.complexityAdjustment < 0);
  assert.equal(ordinary.complexityAdjustment, 0, 'C** is the ordinary case and moves nothing');
  assert.ok(Math.abs(hard.complexityAdjustment) <= 12, 'bounded — a nudge, not a different verdict');
  assert.ok(Math.abs(easy.complexityAdjustment) <= 12);
});

test('complexity does not cancel out the size penalty', () => {
  const hardSmall = devScore.compute({ ...BASE, ratings: [{ complexity: 5, length: 1 }] });
  const hardHuge = devScore.compute({ ...BASE, ratings: [{ complexity: 5, length: 5 }] });
  assert.ok(hardHuge.score < hardSmall.score, 'a hard change delivered as a huge diff still scores worse');
  assert.equal(hardHuge.components.find((c) => c.key === 'mrSize').score, 0);
});

test('the reason line says the complexity adjustment out loud', () => {
  const out = devScore.compute({ ...BASE, ratings: [{ complexity: 5, length: 1 }] });
  assert.match(out.reason, /بابت پیچیدگی/);
  assert.equal(devScore.compute({ ...BASE, ratings: [] }).reason.includes('پیچیدگی'), false);
});

test('formatRating round-trips what a maintainer would type', () => {
  assert.equal(difficulty.formatRating({ complexity: 3, length: 2 }), 'C*** L**');
  assert.equal(difficulty.formatRating({ complexity: null, length: 5 }), 'L*****');
  assert.equal(difficulty.formatRating(null), '');
});
