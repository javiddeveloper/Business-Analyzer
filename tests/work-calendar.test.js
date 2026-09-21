// lib/workCalendar.js: which days this org works, read from WORKING_DAYS.
// The one property that matters most: when it's unset, every calculation
// here must be byte-for-byte the same as the flat calendar-day math the
// rest of the project already does — this is opt-in, not a silent change
// in behaviour for anyone who never configures it.
const test = require('node:test');
const assert = require('node:assert');

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

function freshCalendar(workingDaysEnv) {
  stub('../lib/ai_bridge', { secret: (k) => (k === 'WORKING_DAYS' ? (workingDaysEnv || '') : '') });
  delete require.cache[require.resolve('../lib/workCalendar')];
  return require('../lib/workCalendar');
}

const DAY = 86400000;

test('unset WORKING_DAYS means every day counts — workingDayIndices is null, isWorkingDay is always true', () => {
  const wc = freshCalendar('');
  assert.equal(wc.workingDayIndices(), null);
  assert.equal(wc.isWorkingDay('2026-09-19'), true); // a Saturday
  assert.equal(wc.isWorkingDay('2026-09-18'), true); // a Friday
});

test('unset WORKING_DAYS: workingDaysBetween is exactly the flat calendar-day span', () => {
  const wc = freshCalendar('');
  const from = Date.parse('2026-09-10T00:00:00Z');
  const to = Date.parse('2026-09-17T12:00:00Z'); // 7.5 calendar days later
  assert.equal(wc.workingDaysBetween(from, to), 7.5);
});

test('parses Persian weekday names and recognises Iran\'s standard weekend (Thu/Fri off)', () => {
  const wc = freshCalendar('شنبه,یکشنبه,دوشنبه,سه‌شنبه,چهارشنبه');
  // 2026-09-19 is a Saturday (UTC), 2026-09-17 a Thursday, 2026-09-18 a Friday.
  assert.equal(wc.isWorkingDay('2026-09-19'), true);
  assert.equal(wc.isWorkingDay('2026-09-16'), true, 'Wednesday');
  assert.equal(wc.isWorkingDay('2026-09-17'), false, 'Thursday');
  assert.equal(wc.isWorkingDay('2026-09-18'), false, 'Friday');
});

test('an unrecognised value still falls back to the defensible Iran default rather than "every day"', () => {
  const wc = freshCalendar('این یک روز نیست');
  assert.deepEqual(wc.workingDayIndices().sort(), wc.DEFAULT_WORKING_DAYS.slice().sort());
});

test('workingDaysBetween skips the configured weekend entirely', () => {
  const wc = freshCalendar('شنبه,یکشنبه,دوشنبه,سه‌شنبه,چهارشنبه');
  // Thu 2026-09-17 00:00 -> Sat 2026-09-19 00:00: two full calendar days
  // (Thu, Fri), both off — the span between them must be 0 working days.
  const from = Date.parse('2026-09-17T00:00:00Z'); // Thursday midnight
  const to = Date.parse('2026-09-19T00:00:00Z');   // Saturday midnight
  assert.equal(wc.workingDaysBetween(from, to), 0, 'Thu and Fri are the only calendar days in between, and both are off');
});

test('workingDaysBetween counts a working-day span correctly across a weekend', () => {
  const wc = freshCalendar('شنبه,یکشنبه,دوشنبه,سه‌شنبه,چهارشنبه');
  // Wed 2026-09-16 09:00 -> Sun 2026-09-20 09:00 (calendar: 4 days).
  // Thu/Fri off; Wed contributes the rest of that day (15h = 0.625d);
  // Sat contributes a full day; Sun contributes 9h (0.375d) up to `to`.
  const from = Date.parse('2026-09-16T09:00:00Z');
  const to = Date.parse('2026-09-20T09:00:00Z');
  const result = wc.workingDaysBetween(from, to);
  assert.ok(Math.abs(result - 2) < 0.001, `expected ~2 working days, got ${result}`);
});

test('workingDaysBetween returns 0 for a non-positive span, never negative', () => {
  const wc = freshCalendar('شنبه,یکشنبه,دوشنبه,سه‌شنبه,چهارشنبه');
  assert.equal(wc.workingDaysBetween(Date.now(), Date.now() - DAY), 0);
});

test('isWorkingDay accepts an explicit override without touching the configured value', () => {
  const wc = freshCalendar('شنبه,یکشنبه,دوشنبه,سه‌شنبه,چهارشنبه');
  assert.equal(wc.isWorkingDay('2026-09-17', [4]), true, 'Thursday, but the override made Thursday(4) the only working day');
});
