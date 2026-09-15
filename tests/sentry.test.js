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
