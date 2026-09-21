// Which days this org actually works — read from WORKING_DAYS in
// secrets.env (see lib/envFile.js). Exists so a "how late is this, really"
// question can be answered in working days instead of flat calendar days:
// a task due Wednesday and delivered the following Sunday is one working
// day late somewhere that doesn't work Thu/Fri, not four.
//
// Deliberately does nothing yet beyond counting weekends — no holiday list
// is wired in. Blocked on knowing where that list should actually come from
// (there is no generic "Jira calendar" API; whatever supplies public
// holidays here needs to be a real, named source before this claims to
// account for them). See workingDaysBetween's own comment.
const { secret } = require('./ai_bridge');

const DAY_NAME_TO_INDEX = {
  'یکشنبه': 0, 'دوشنبه': 1, 'سه‌شنبه': 2, 'سه شنبه': 2, 'چهارشنبه': 3,
  'پنجشنبه': 4, 'جمعه': 5, 'شنبه': 6,
};

// Iran's standard week (Sat–Wed working, Thu/Fri weekend) — used only when
// WORKING_DAYS is set but empty of any name this module recognises, so a
// typo doesn't silently fall back to "every day is a working day" without
// at least a defensible default.
const DEFAULT_WORKING_DAYS = [6, 0, 1, 2, 3]; // شنبه..چهارشنبه

// Empty/unset means "every day is a working day" — the flat calendar-day
// behaviour every date calculation in this project has always had, so a
// site that never configures this sees no change at all.
function workingDayIndices() {
  const raw = secret('WORKING_DAYS');
  if (!raw || !raw.trim()) return null;
  const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const indices = names.map((n) => DAY_NAME_TO_INDEX[n]).filter((n) => n != null);
  return indices.length ? Array.from(new Set(indices)) : DEFAULT_WORKING_DAYS;
}

function isWorkingDay(date, workingDays) {
  const days = workingDays !== undefined ? workingDays : workingDayIndices();
  if (!days) return true; // not configured — every day counts, as before
  return days.includes(new Date(date).getUTCDay());
}

// Working days strictly between two instants (exclusive of `from`, inclusive
// of `to`) — the unit "how many working days late" needs. Calendar days when
// WORKING_DAYS isn't configured, so lateTaskScore's existing math is
// unaffected until someone opts in.
//
// Holidays are NOT subtracted — only the weekend pattern is. A public
// holiday still turns up as a working day here, which understates how much
// slack a person actually had. Wiring in a real holiday list needs a real
// source for one first (Jira has no built-in company holiday calendar
// without a marketplace add-on; whichever add-on or manually-maintained
// list this org actually uses has to be named before this can read it).
function workingDaysBetween(fromMs, toMs, workingDays) {
  const days = workingDays !== undefined ? workingDays : workingDayIndices();
  if (toMs <= fromMs) return 0;
  const DAY = 86400000;
  if (!days) return (toMs - fromMs) / DAY; // calendar days, fractional — matches today's behaviour exactly
  let count = 0;
  // Walk whole days from the calendar day after `from` through the calendar
  // day of `to`, then correct for the partial first/last day so a same-day
  // span still returns a fraction rather than rounding to a whole day.
  const start = new Date(fromMs);
  const startDay = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const end = new Date(toMs);
  const endDay = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  for (let d = startDay; d <= endDay; d += DAY) {
    if (!days.includes(new Date(d).getUTCDay())) continue;
    const dayStart = Math.max(d, fromMs);
    const dayEnd = Math.min(d + DAY, toMs);
    count += Math.max(0, dayEnd - dayStart) / DAY;
  }
  return count;
}

module.exports = { isWorkingDay, workingDaysBetween, workingDayIndices, DAY_NAME_TO_INDEX, DEFAULT_WORKING_DAYS };
