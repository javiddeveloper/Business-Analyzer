// Turning a Sentry error into a Jira ticket: the defaults it starts from,
// the body it carries, and the record that stops the same error being filed
// twice.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

function freshTasks() {
  process.env.CR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-sentry-'));
  delete require.cache[require.resolve('../lib/sentryTasks')];
  return require('../lib/sentryTasks');
}

const NOW = Date.parse('2026-09-15T12:00:00Z');
const issue = (over = {}) => ({
  id: '991', shortId: 'MOBILE-7Q', project: 'mobile',
  title: 'NullPointerException', value: 'name must not be null',
  culprit: 'HealthProfileViewModel.submit', level: 'error',
  count: 120, userCount: 4,
  firstSeen: '2026-09-01T10:00:00Z', lastSeen: '2026-09-15T09:00:00Z',
  permalink: 'https://sentry.example/issues/991/',
  ...over,
});

test('a worse level gets a nearer deadline and a bigger estimate', () => {
  const t = freshTasks();
  const fatal = t.defaultsFor(issue({ level: 'fatal' }), NOW);
  const err = t.defaultsFor(issue({ level: 'error' }), NOW);
  const warn = t.defaultsFor(issue({ level: 'warning' }), NOW);

  assert.ok(fatal.dueInDays < err.dueInDays, 'fatal is due before error');
  assert.ok(err.dueInDays < warn.dueInDays, 'error is due before warning');
  assert.ok(fatal.estimateHours > warn.estimateHours, 'and the worse one is budgeted more time');
  assert.equal(fatal.dueDate, '2026-09-16', 'one day out from the fixed "now"');
});

// Level alone cannot tell an error hitting two people from one hitting four
// hundred, and they are not the same ticket.
test('a widespread error is pulled forward, but never to today', () => {
  const t = freshTasks();
  const few = t.defaultsFor(issue({ level: 'error', userCount: 2 }), NOW);
  const many = t.defaultsFor(issue({ level: 'error', userCount: 500 }), NOW);
  assert.ok(many.dueInDays < few.dueInDays, 'more affected users means a nearer date');
  assert.equal(many.widespread, true);

  // A ticket created this afternoon and due today is overdue before anyone
  // reads it — and this org's score counts overdue tickets.
  const worst = t.defaultsFor(issue({ level: 'fatal', userCount: 5000 }), NOW);
  assert.ok(worst.dueInDays >= 1, `never same-day, got ${worst.dueInDays}`);
});

test('an unknown or missing level still gets usable defaults', () => {
  const t = freshTasks();
  for (const level of [undefined, null, '', 'something-else']) {
    const d = t.defaultsFor(issue({ level }), NOW);
    assert.ok(d.dueDate && d.estimateHours > 0, `level ${JSON.stringify(level)} produced no usable default`);
  }
});

test('the description carries what someone who never opens Sentry still needs', () => {
  const t = freshTasks();
  const body = t.buildDescription(issue());
  for (const needle of ['MOBILE-7Q', 'NullPointerException', 'name must not be null',
    'HealthProfileViewModel.submit', '120', 'https://sentry.example/issues/991/']) {
    assert.ok(body.includes(needle), `description is missing ${needle}`);
  }
});

test('the summary is tagged and stays inside Jira\'s length limit', () => {
  const t = freshTasks();
  assert.match(t.buildSummary(issue()), /^\[Sentry\] /);
  const long = t.buildSummary(issue({ title: 'x'.repeat(400) }));
  assert.ok(long.length <= 240, `summary too long: ${long.length}`);
  assert.match(long, /^\[Sentry\] /, 'the prefix survives the trim, so these stay identifiable as a group');
});

// Without this the dashboard offers "create a task" on an error somebody
// filed last week — and the loudest error is the one most likely to be
// clicked twice.
test('a filed error remembers its ticket, keyed on the stable Sentry id', () => {
  const t = freshTasks();
  assert.equal(t.linkFor('991'), null);

  t.recordLink('991', { key: 'EM-5000', url: 'https://jira/browse/EM-5000', summary: 's' });
  assert.equal(t.linkFor('991').key, 'EM-5000');
  assert.equal(t.linkFor(991).key, 'EM-5000', 'number or string id, same record');
  assert.equal(t.linkFor('992'), null, 'and only that error');

  assert.deepEqual(Object.keys(t.linksFor(['991', '992'])), ['991']);
});

test('estimate hours become Jira duration strings', () => {
  const jira = require('../lib/jira');
  assert.equal(jira.toEstimateString(4), '4h');
  assert.equal(jira.toEstimateString(1.5), '1h 30m');
  assert.equal(jira.toEstimateString(0.25), '15m');
  assert.equal(jira.toEstimateString(0), null, 'zero is not an estimate Jira will accept');
  assert.equal(jira.toEstimateString('abc'), null);
});

test('listIssues sorts worst-first, then loudest', () => {
  const sentry = require('../lib/sentry');
  assert.ok(sentry.levelRank('fatal') < sentry.levelRank('error'));
  assert.ok(sentry.levelRank('error') < sentry.levelRank('warning'));
  assert.ok(sentry.levelRank('warning') < sentry.levelRank('info'));
  assert.ok(sentry.levelRank('nonsense') > sentry.levelRank('debug'), 'an unknown level sorts last, not first');
});

// ---- per-project config ----------------------------------------------------

test('Sentry and Jira projects resolve per repository, falling back to the globals', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-projcfg-'));
  process.env.CR_DATA_DIR = dir;
  const bridgePath = require.resolve('../lib/ai_bridge');
  const saved = require.cache[bridgePath];
  require.cache[bridgePath] = {
    id: bridgePath, filename: bridgePath, loaded: true,
    exports: { secret: (k) => ({ SENTRY_PROJECT: 'global-proj', JIRA_PROJECT_KEY: 'GLOB' }[k] || '') },
  };
  delete require.cache[require.resolve('../lib/projects')];
  const projects = require('../lib/projects');
  try {
    projects.upsertProject({ id: '1', name: 'mobile', path: '/tmp/a', sentryProject: 'tamin-mobile', jiraProjectKey: 'em' });
    projects.upsertProject({ id: '2', name: 'backend', path: '/tmp/b' }); // no per-project values

    assert.deepEqual(projects.getSentryProjects('1'), ['tamin-mobile']);
    assert.equal(projects.getJiraProjectKey('1'), 'EM', 'the key is upper-cased, since Jira keys are');

    assert.deepEqual(projects.getSentryProjects('2'), ['global-proj'], 'falls back to SENTRY_PROJECT');
    assert.equal(projects.getJiraProjectKey('2'), 'GLOB', 'falls back to JIRA_PROJECT_KEY');

    projects.upsertProject({ id: '3', name: 'multi', path: '/tmp/c', sentryProject: 'a, b ,c' });
    assert.deepEqual(projects.getSentryProjects('3'), ['a', 'b', 'c'], 'one repo can report into several Sentry projects');
  } finally {
    require.cache[bridgePath] = saved;
    delete require.cache[require.resolve('../lib/projects')];
  }
});

// ---- priority and assignee -------------------------------------------------

test('priority follows severity, and reach escalates it one step', () => {
  const a = require('../lib/sentryAnalysis');
  assert.equal(a.priorityFor({ level: 'fatal', userCount: 1 }), 'Highest');
  assert.equal(a.priorityFor({ level: 'error', userCount: 1 }), 'High');
  assert.equal(a.priorityFor({ level: 'warning', userCount: 1 }), 'Medium');

  assert.equal(a.priorityFor({ level: 'error', userCount: 500 }), 'Highest', 'reach escalates High to Highest');
  assert.equal(a.priorityFor({ level: 'warning', userCount: 500 }), 'High');
  assert.equal(a.priorityFor({ level: 'nonsense', userCount: 0 }), 'Medium', 'an unknown level is not silently Low');
});

test('the freest developer is suggested first, counting work in flight', () => {
  const a = require('../lib/sentryAnalysis');
  const rows = [
    { username: 'busy', name: 'Busy', inProgressCount: 6, openMrs: 3, attention: 5 },
    { username: 'free', name: 'Free', inProgressCount: 1, openMrs: 0, attention: 0 },
    { username: 'mid', name: 'Mid', inProgressCount: 3, openMrs: 1, attention: 1 },
  ];
  const out = a.suggestAssignees(rows);
  assert.deepEqual(out.map((r) => r.username), ['free', 'mid', 'busy']);
  assert.ok(out[0].load < out[2].load);
  // The numbers travel with the name: "assign to X" nobody can check is not
  // a suggestion, it is an instruction.
  assert.equal(out[0].inProgress, 1);
  assert.equal(out[0].openMrs, 0);
});

test('rows that are still loading or failed are never suggested', () => {
  const a = require('../lib/sentryAnalysis');
  const out = a.suggestAssignees([
    { username: 'ok', name: 'Ok', inProgressCount: 2, openMrs: 1, attention: 0 },
    { username: 'pending', name: 'P', pending: true },
    { username: 'broken', name: 'B', error: 'gitlab 500' },
    { name: 'nameless' },
  ]);
  assert.deepEqual(out.map((r) => r.username), ['ok']);
});

test('an empty team produces no suggestion rather than a made-up one', () => {
  const a = require('../lib/sentryAnalysis');
  assert.deepEqual(a.suggestAssignees([]), []);
  assert.deepEqual(a.suggestAssignees(null), []);
});

// ---- the enriched ticket body ----------------------------------------------

test('the description carries the stack and marks the interpretation as a model output', () => {
  const t = freshTasks();
  const body = t.buildDescription(issue(), {
    analysis: { summary: 'خلاصه', cause: 'علت', where: 'HealthApi.kt', fix: 'راه حل' },
    stack: 'NullPointerException\n  > HealthApi.kt:42 — get',
  });
  assert.ok(body.includes('HealthApi.kt:42'), 'the stack is in the ticket');
  assert.ok(body.includes('{code}'), 'and wrapped so Jira renders it as a block');
  assert.ok(body.includes('خلاصه') && body.includes('علت'), 'the interpretation is included');
  assert.match(body, /تولید مدل/, 'and labelled as a model output, not as diagnosis');
});

test('a ticket filed before the model answered is still complete, just shorter', () => {
  const t = freshTasks();
  const body = t.buildDescription(issue(), { analysis: { error: 'timeout' }, stack: null });
  assert.ok(!body.includes('تفسیر خودکار'), 'a failed analysis contributes nothing rather than an error notice');
  assert.ok(body.includes('NullPointerException'), 'the error itself is still there');
  assert.ok(body.includes('https://sentry.example/issues/991/'));
});
