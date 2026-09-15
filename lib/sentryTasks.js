// Two things: the defaults a Jira task gets when it is created from a Sentry
// issue, and the record of which Sentry issues already have one.
//
// The record matters more than it looks. Without it the dashboard offers
// "create a task" on an error somebody already filed last week, and the
// backlog fills with duplicates of the loudest error in the project —
// precisely the one most likely to be clicked twice.
const fs = require('fs');
const path = require('path');
const { atomicWriteFileSync } = require('./atomicWrite');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.CR_DATA_DIR ? path.resolve(process.env.CR_DATA_DIR) : path.join(ROOT, 'data');
const LINKS_PATH = path.join(DATA, 'sentry-tasks.json');

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(LINKS_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeAll(all) {
  fs.mkdirSync(DATA, { recursive: true });
  atomicWriteFileSync(LINKS_PATH, JSON.stringify(all, null, 2));
}

// Keyed by Sentry's own issue id, which is stable across the title changing
// as the error evolves — the shortId is not, and the title certainly is not.
function linkFor(sentryIssueId) {
  return readAll()[String(sentryIssueId)] || null;
}

function recordLink(sentryIssueId, { key, url, summary }) {
  const all = readAll();
  all[String(sentryIssueId)] = { key, url, summary: summary || null, at: Date.now() };
  writeAll(all);
  return all[String(sentryIssueId)];
}

function linksFor(sentryIssueIds) {
  const all = readAll();
  const out = {};
  for (const id of sentryIssueIds || []) {
    const hit = all[String(id)];
    if (hit) out[String(id)] = hit;
  }
  return out;
}

// Severity drives the defaults, because the alternative — one fixed due date
// and one fixed estimate for everything — makes the mandatory fields pure
// ceremony: everybody accepts whatever was prefilled and the numbers stop
// meaning anything. These are a starting point the form still lets you edit,
// not a judgement about the work.
//
// Deadlines are deliberately short at the top end. A `fatal` that users are
// hitting now is not a two-week ticket, and giving it a two-week date is how
// it ends up buried under things that merely look more urgent on the board.
const LEVEL_DEFAULTS = {
  fatal: { dueInDays: 1, estimateHours: 8 },
  error: { dueInDays: 3, estimateHours: 4 },
  warning: { dueInDays: 7, estimateHours: 2 },
  info: { dueInDays: 14, estimateHours: 1 },
  debug: { dueInDays: 14, estimateHours: 1 },
};
const FALLBACK_DEFAULT = { dueInDays: 7, estimateHours: 2 };

// How many affected users pulls a deadline forward one step. An `error`
// hitting two people and one hitting four hundred are not the same ticket,
// and the level alone cannot tell them apart.
const WIDESPREAD_USERS = 50;

function isoDatePlusDays(days, now = Date.now()) {
  const d = new Date(now + days * 86400000);
  return d.toISOString().slice(0, 10);
}

function defaultsFor(issue, now = Date.now()) {
  const base = LEVEL_DEFAULTS[String(issue && issue.level || '').toLowerCase()] || FALLBACK_DEFAULT;
  const widespread = (Number(issue && issue.userCount) || 0) >= WIDESPREAD_USERS;
  // Never below one day: a due date of today on a ticket created this
  // afternoon is overdue before anybody reads it, and this org's score
  // counts overdue tickets.
  const dueInDays = widespread ? Math.max(1, base.dueInDays - 2) : base.dueInDays;
  return {
    dueDate: isoDatePlusDays(dueInDays, now),
    estimateHours: base.estimateHours,
    dueInDays,
    widespread,
  };
}

// The task body, in Jira's own wiki markup. Written so somebody who never
// opens Sentry still knows what they are fixing: the numbers, the Persian
// reading of the crash, the actual stack, and the permalink for when they do
// want the full event.
//
// `analysis` and `stack` are optional — a ticket filed before the model
// answered, or on an issue Sentry has no stored event for, is still worth
// filing, just shorter.
function buildDescription(issue, { analysis, stack } = {}) {
  const lines = [
    `گزارش‌شده از Sentry — ${issue.shortId || issue.id}`,
    '',
    `*خطا:* ${issue.title}`,
  ];
  if (issue.value && issue.value !== issue.title) lines.push(`*پیام:* ${issue.value}`);
  if (issue.culprit) lines.push(`*محل:* {{${issue.culprit}}}`);
  lines.push(
    '',
    `*سطح:* ${issue.level || '—'}`,
    `*تعداد رخداد:* ${issue.count}`,
    `*کاربران متأثر:* ${issue.userCount}`,
    `*اولین بار:* ${issue.firstSeen || '—'}`,
    `*آخرین بار:* ${issue.lastSeen || '—'}`,
    `*پروژه:* ${issue.project || '—'}`,
  );
  if (issue.release) lines.push(`*نسخه:* ${issue.release}`);
  if (issue.environment) lines.push(`*محیط:* ${issue.environment}`);

  // Marked as a machine reading, not as fact. It is a model interpreting a
  // stack trace, and a ticket that presents that as diagnosis sends somebody
  // down a confident wrong path.
  if (analysis && !analysis.error) {
    lines.push('', 'h3. تفسیر خودکار (تولید مدل — بررسی شود، قطعی نیست)');
    if (analysis.summary) lines.push(`*چه اتفاقی می‌افتد:* ${analysis.summary}`);
    if (analysis.cause) lines.push(`*علت محتمل:* ${analysis.cause}`);
    if (analysis.where) lines.push(`*از کجا شروع کن:* ${analysis.where}`);
    if (analysis.fix) lines.push(`*پیشنهاد رفع:* ${analysis.fix}`);
  }

  if (stack) {
    lines.push('', 'h3. استک‌تریس', '{code}', stack, '{code}');
  }

  lines.push('', `لینک در Sentry: ${issue.permalink}`);
  return lines.join('\n');
}

function buildSummary(issue) {
  // Prefixed so these are identifiable as a group on the board, and capped
  // well under Jira's 250 so the prefix is never what gets cut off.
  const head = `[Sentry] ${issue.title}`;
  return head.length > 240 ? head.slice(0, 239) + '…' : head;
}

module.exports = {
  linkFor, recordLink, linksFor,
  defaultsFor, buildDescription, buildSummary,
  LEVEL_DEFAULTS, WIDESPREAD_USERS, isoDatePlusDays,
};
