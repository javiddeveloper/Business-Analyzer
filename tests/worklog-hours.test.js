// lib/worklogHours.js: logged hours bucketed into Saturday-start weeks and
// Jalali months, each against its working-day capacity. Fixed `now` and an
// explicit Sat–Wed working week so nothing depends on the machine's clock
// or on secrets.env.
const test = require('node:test');
const assert = require('node:assert');
const wh = require('../lib/worklogHours');

const NOW = Date.parse('2026-09-22T09:00:00Z');   // Tuesday, 31 شهریور 1405 (Tehran)
const WORK = [6, 0, 1, 2, 3];                      // Sat–Wed
const H = 3600;

test('weeks start on Saturday and the current week is measured against the capacity elapsed so far', () => {
  const out = wh.buildHours([
    { started: '2026-09-20T08:00:00.000+0330', seconds: 4 * H },
    { started: '2026-09-14T10:00:00.000+0330', seconds: 8 * H },
  ], { now: NOW, workingDays: WORK });
  assert.equal(out.weeks.length, 8);
  assert.equal(out.thisWeek.key, '2026-09-19', 'the Saturday that starts this week');
  assert.equal(out.thisWeek.current, true);
  assert.equal(out.thisWeek.hours, 4);
  assert.equal(out.thisWeek.capacityHours, 40, '5 working days × 8h, not 7 × 8');
  assert.equal(out.thisWeek.capacitySoFarHours, 32, 'Sat, Sun, Mon, Tue so far');
  assert.equal(out.weeks[6].hours, 8, 'the previous week');
});

test('an hour logged after midnight Tehran time lands on that Tehran day, not the UTC one', () => {
  // 00:30 Saturday Tehran = 21:00 Friday UTC — the previous week in UTC.
  const out = wh.buildHours([{ started: '2026-09-19T00:30:00.000+0330', seconds: 2 * H }], { now: NOW, workingDays: WORK });
  assert.equal(out.thisWeek.hours, 2);
});

test('months are Jalali months, not Gregorian ones', () => {
  // 23 Aug 2026 = 1 شهریور; 22 Aug = 31 مرداد.
  const out = wh.buildHours([
    { started: '2026-08-23T10:00:00.000+0330', seconds: 5 * H },
    { started: '2026-08-22T10:00:00.000+0330', seconds: 3 * H },
  ], { now: NOW, workingDays: WORK });
  assert.equal(out.thisMonth.key, '1405-06');
  assert.match(out.thisMonth.label, /شهریور/);
  assert.equal(out.thisMonth.hours, 5);
  assert.equal(out.months[4].key, '1405-05');
  assert.equal(out.months[4].hours, 3);
  assert.equal(out.months.length, 6);
});

test('an entry outside every window is ignored rather than miscounted', () => {
  const out = wh.buildHours([{ started: '2024-01-01T10:00:00.000+0330', seconds: 9 * H }], { now: NOW, workingDays: WORK });
  assert.equal(out.weeks.reduce((s, w) => s + w.hours, 0), 0);
  assert.equal(out.months.reduce((s, m) => s + m.hours, 0), 0);
});

test('lookbackSince reaches far enough back to fill the oldest month and week', () => {
  const since = wh.lookbackSince({ now: NOW });
  // Six Jalali months back from شهریور starts on 1 فروردین 1405 = 21 March 2026.
  assert.ok(since <= '2026-03-21', `expected on or before 2026-03-21, got ${since}`);
  assert.ok(since >= '2026-03-15', 'but not months further than it needs to');
});
