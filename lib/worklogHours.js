// Hours a person logged in Jira, bucketed into weeks and months — the
// "ساعت کارکرد هفتگی و ماهانه" on the team-member page.
//
// Built from worklog entries (each with the date it was logged), never from
// a task's own timespent: that is a single all-time total across everyone
// who ever logged on the ticket, with no date on it at all, so it cannot say
// which week an hour belongs to.
//
// Calendar decisions, all made for how this team actually reads dates:
//   - Days are Tehran days. An hour logged at 01:00 Tehran time belongs to
//     that morning, not to "yesterday in UTC".
//   - Weeks start on Saturday (the Iranian week), keyed by that Saturday's
//     Gregorian date so they sort as plain strings.
//   - Months are Jalali months (شهریور, مهر…), not Gregorian ones — a
//     "monthly" figure that cut across the middle of شهریور would match no
//     payroll or timesheet anyone here keeps.
//   - Capacity is working days × hours/day, with working days from
//     lib/workCalendar.js (the WORKING_DAYS setting), so the week's target
//     is 5 × 8 = 40h on the default Sat–Wed week, not 7 × 8.
const workCalendar = require('./workCalendar');

const DAY = 86400000;
const HOURS_PER_DAY = 8;
const TZ = 'Asia/Tehran';

const tehranYmd = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const jalaliParts = new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', { timeZone: 'UTC', year: 'numeric', month: 'numeric' });
const faMonthName = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'UTC', month: 'long' });
const faYear = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'UTC', year: 'numeric' });
const faDayMonth = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'UTC', day: 'numeric', month: 'short' });

// A Tehran calendar day, represented as noon UTC of that Gregorian date —
// noon so no timezone arithmetic downstream can tip it into a neighbouring
// day, and so getUTCDay() is that date's own weekday.
function tehranDay(ms) {
  const [y, m, d] = tehranYmd.format(new Date(ms)).split('-').map(Number);
  return Date.UTC(y, m - 1, d, 12);
}

function jalaliMonthKey(dayMs) {
  const parts = jalaliParts.formatToParts(new Date(dayMs));
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value.padStart(2, '0');
  return `${y}-${m}`;
}

// Built from parts: formatting year and month together renders them
// backwards ("۱۴۰۵ شهریور") — the same trap lib/monthly.js's faMonthLabel
// works around.
function jalaliMonthLabel(dayMs) {
  const d = new Date(dayMs);
  return `${faMonthName.format(d)} ${faYear.format(d)}`;
}

function saturdayOf(dayMs) {
  const sinceSaturday = (new Date(dayMs).getUTCDay() + 1) % 7; // Sat=0 … Fri=6
  return dayMs - sinceSaturday * DAY;
}

function isoDay(dayMs) {
  return new Date(dayMs).toISOString().slice(0, 10);
}

const round1 = (n) => Math.round(n * 10) / 10;

// entries: [{ started: ISO string, seconds: number }]. Returns the last
// `weeks` weeks and last `months` Jalali months, oldest first, each with the
// hours logged, the full period's capacity, and — for the period still
// running — the capacity elapsed so far, so "22 of 40" in the middle of a
// week can be read against the 24 that were actually available by today.
function buildHours(entries, { now = Date.now(), weeks = 8, months = 6, hoursPerDay = HOURS_PER_DAY, workingDays } = {}) {
  const today = tehranDay(now);
  const isWorking = (dayMs) => workCalendar.isWorkingDay(dayMs, workingDays);

  // Which weeks: the current one and the `weeks - 1` before it.
  const thisWeek = saturdayOf(today);
  const weekStarts = [];
  for (let k = weeks - 1; k >= 0; k--) weekStarts.push(thisWeek - k * 7 * DAY);

  // Which months: walk back a day at a time until `months` distinct Jalali
  // months have been seen, then to the first day of the oldest of them.
  const monthKeys = [];
  let cursor = today;
  while (monthKeys.length < months) {
    const key = jalaliMonthKey(cursor);
    if (monthKeys[0] !== key) monthKeys.unshift(key);
    cursor -= DAY;
  }
  while (jalaliMonthKey(cursor) === monthKeys[0]) cursor -= DAY;
  const firstMonthDay = cursor + DAY;

  // Last day that matters: the end of this week or of this month, whichever
  // is later, so both current periods get their full-period capacity.
  let lastMonthDay = today;
  while (jalaliMonthKey(lastMonthDay + DAY) === monthKeys[monthKeys.length - 1]) lastMonthDay += DAY;
  const rangeStart = Math.min(weekStarts[0], firstMonthDay);
  const rangeEnd = Math.max(thisWeek + 6 * DAY, lastMonthDay);

  const weekBuckets = new Map(weekStarts.map((ws) => [ws, {
    key: isoDay(ws), label: faDayMonth.format(new Date(ws)),
    seconds: 0, capacityHours: 0, capacitySoFarHours: 0, current: ws === thisWeek,
  }]));
  const monthBuckets = new Map(monthKeys.map((key) => [key, {
    key, label: null, seconds: 0, capacityHours: 0, capacitySoFarHours: 0, current: key === monthKeys[monthKeys.length - 1],
  }]));

  for (let d = rangeStart; d <= rangeEnd; d += DAY) {
    const wb = weekBuckets.get(saturdayOf(d));
    const mb = monthBuckets.get(jalaliMonthKey(d));
    if (mb && !mb.label) mb.label = jalaliMonthLabel(d);
    if (!isWorking(d)) continue;
    for (const b of [wb, mb]) {
      if (!b) continue;
      b.capacityHours += hoursPerDay;
      if (d <= today) b.capacitySoFarHours += hoursPerDay;
    }
  }

  let unplaced = 0;
  for (const e of entries || []) {
    const at = Date.parse(e.started);
    if (!Number.isFinite(at)) continue;
    const d = tehranDay(at);
    const wb = weekBuckets.get(saturdayOf(d));
    const mb = monthBuckets.get(jalaliMonthKey(d));
    if (wb) wb.seconds += e.seconds || 0;
    if (mb) mb.seconds += e.seconds || 0;
    if (!wb && !mb) unplaced++;
  }

  const finish = (b) => ({
    key: b.key, label: b.label, current: b.current,
    hours: round1(b.seconds / 3600),
    capacityHours: b.capacityHours,
    capacitySoFarHours: b.capacitySoFarHours,
  });
  const weekList = weekStarts.map((ws) => finish(weekBuckets.get(ws)));
  const monthList = monthKeys.map((k) => finish(monthBuckets.get(k)));
  return {
    weeks: weekList,
    months: monthList,
    thisWeek: weekList[weekList.length - 1],
    thisMonth: monthList[monthList.length - 1],
    hoursPerDay,
  };
}

// How far back the worklog search has to reach to fill every bucket
// buildHours will ask for — the older of the two windows' first days, as a
// YYYY-MM-DD for Jira's worklogDate clause. A day of slack covers the
// Tehran/UTC offset on the boundary.
function lookbackSince({ now = Date.now(), weeks = 8, months = 6 } = {}) {
  const today = tehranDay(now);
  const weekStart = saturdayOf(today) - (weeks - 1) * 7 * DAY;
  const seen = [];
  let cursor = today;
  while (seen.length < months) {
    const key = jalaliMonthKey(cursor);
    if (seen[0] !== key) seen.unshift(key);
    cursor -= DAY;
  }
  while (jalaliMonthKey(cursor) === seen[0]) cursor -= DAY;
  return isoDay(Math.min(weekStart, cursor + DAY) - DAY);
}

module.exports = { buildHours, lookbackSince, tehranDay, jalaliMonthKey, saturdayOf, HOURS_PER_DAY };
