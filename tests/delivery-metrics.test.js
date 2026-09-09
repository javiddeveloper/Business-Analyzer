// lib/deliveryMetrics.js — the GitLab-derived half of the report, added
// because everything Jira-derived rests on fields this org fills only partly
// (Time Spent ~47%, Story Points 0%, review reports on 4 of 50 MRs).
const test = require('node:test');
const assert = require('node:assert');
const dm = require('../lib/deliveryMetrics');

const NOW = Date.parse('2026-09-09T12:00:00Z');
const HOUR = 3600000;
const iso = (msFromNow) => new Date(NOW + msFromNow).toISOString();

test('median and p90 describe a skewed set better than a mean would', () => {
  // Four quick MRs and one that sat open for a month — the shape real cycle
  // times take, and the reason a mean is not reported.
  const values = [2, 3, 4, 5, 700];
  assert.equal(dm.median(values), 4);
  assert.equal(dm.percentile(values, 90), 700, 'the tail stays visible instead of being averaged away');
  assert.equal(dm.median([]), null, 'no data reports nothing, not zero');
});

test('median handles an even-length set by averaging the middle pair', () => {
  assert.equal(dm.median([1, 2, 3, 4]), 2.5);
});

test('open-to-merge is measured only on merged MRs', () => {
  const out = dm.summarize([
    { state: 'merged', createdAt: iso(-10 * HOUR), mergedAt: iso(-8 * HOUR) },   // 2h
    { state: 'merged', createdAt: iso(-30 * HOUR), mergedAt: iso(-24 * HOUR) },  // 6h
    { state: 'opened', createdAt: iso(-100 * HOUR), mergedAt: null },            // still open
  ], { now: NOW });

  assert.equal(out.mrCount, 3);
  assert.equal(out.mergedCount, 2);
  assert.equal(out.openToMergeSample, 2, 'the open one is not silently counted as instant');
  assert.equal(out.medianOpenToMergeHours, 4);
  assert.equal(out.stillOpenCount, 1);
  assert.equal(out.medianOpenAgeHours, 100, 'and its age is reported instead');
});

// Cycle time counts the work, not just the review wait — but the commits it
// needs are only fetched for MRs that have a review report, so it must carry
// its own sample size rather than looking like it covers everything.
test('cycle time reports its own smaller sample, separate from open-to-merge', () => {
  const out = dm.summarize([
    { state: 'merged', createdAt: iso(-10 * HOUR), mergedAt: iso(-8 * HOUR), firstCommitAt: iso(-20 * HOUR) },
    { state: 'merged', createdAt: iso(-10 * HOUR), mergedAt: iso(-8 * HOUR), firstCommitAt: null },
  ], { now: NOW });

  assert.equal(out.openToMergeSample, 2);
  assert.equal(out.cycleSample, 1, 'only the MR whose commits we actually fetched');
  assert.equal(out.medianCycleHours, 12);
});

test('commits-after-open excludes unmeasured MRs rather than counting them as zero', () => {
  const out = dm.summarize([
    { state: 'merged', createdAt: iso(-10 * HOUR), mergedAt: iso(-8 * HOUR), commitsAfterOpen: 0 },
    { state: 'merged', createdAt: iso(-10 * HOUR), mergedAt: iso(-8 * HOUR), commitsAfterOpen: 4 },
    { state: 'merged', createdAt: iso(-10 * HOUR), mergedAt: iso(-8 * HOUR), commitsAfterOpen: null }, // not measured
  ], { now: NOW });

  assert.equal(out.afterOpenSample, 2, 'the unmeasured MR is excluded, not counted as clean');
  assert.equal(out.medianCommitsAfterOpen, 2);
});

// Zero discussion is the finding, not a missing value: with no comments from
// anyone but the author, GitLab holds no record that review happened, which
// is why time-to-first-review is not reported at all.
test('discussion share is reported, and zero is stated rather than hidden', () => {
  const mr = (notesCount) => ({ state: 'merged', createdAt: iso(-10 * HOUR), mergedAt: iso(-8 * HOUR), notesCount });
  const none = dm.summarize([mr(0), mr(0), mr(0)], { now: NOW });
  assert.equal(none.discussedPct, 0);
  assert.equal(none.discussedSample, 3);

  const some = dm.summarize([mr(0), mr(3), mr(1), mr(0)], { now: NOW });
  assert.equal(some.discussedPct, 50);
  assert.equal(some.discussedCount, 2);

  assert.equal(dm.summarize([mr(null)], { now: NOW }).discussedPct, null, 'no data is not 0%');
});

test('an empty history reports nulls throughout rather than a wall of zeros', () => {
  const out = dm.summarize([], { now: NOW });
  assert.equal(out.mrCount, 0);
  assert.equal(out.medianOpenToMergeHours, null);
  assert.equal(out.discussedPct, null);
  assert.equal(out.medianNotes, null);
});

test('a merge recorded before its own creation is discarded, not shown as negative', () => {
  const out = dm.summarize([
    { state: 'merged', createdAt: iso(-2 * HOUR), mergedAt: iso(-9 * HOUR) },
  ], { now: NOW });
  assert.equal(out.openToMergeSample, 0);
  assert.equal(out.medianOpenToMergeHours, null);
});

test('humanHours picks a unit a person would actually say', () => {
  assert.equal(dm.humanHours(null), '—');
  assert.equal(dm.humanHours(0.5), '30 دقیقه');
  assert.equal(dm.humanHours(6), '6 ساعت');
  assert.equal(dm.humanHours(72), '3 روز');
  assert.equal(dm.humanHours(24 * 40), '40 روز');
});
