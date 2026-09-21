// lib/sentryBlame.js: who wrote the line Sentry points at. Exercised against
// a real, throwaway git repo rather than mocked git output — a porcelain
// parser that only ever saw hand-written fixtures is exactly the kind of
// thing that breaks on the first real repo it meets.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const sentryBlame = require('../lib/sentryBlame');

function sh(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

// A tiny real repo: one file, two authors, two commits, so blame has
// something to actually distinguish.
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-blame-'));
  sh(dir, ['init', '--quiet']);
  sh(dir, ['config', 'user.email', 'first@example.com']);
  sh(dir, ['config', 'user.name', 'First Person']);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'orders.js'), 'function ok() {\n  return 1;\n}\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '--quiet', '-m', 'first commit']);

  sh(dir, ['config', 'user.email', 'second@example.com']);
  sh(dir, ['config', 'user.name', 'Second Person']);
  fs.writeFileSync(path.join(dir, 'src', 'orders.js'), 'function ok() {\n  return 1;\n}\n\nfunction crashes() {\n  return undefined.x;\n}\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '--quiet', '-m', 'add the bug']);
  return dir;
}

const ISSUE = (filename, lineNo) => ({
  id: 'ISSUE-1',
  release: null,
  exceptions: [{
    type: 'TypeError',
    value: "Cannot read properties of undefined (reading 'x')",
    frames: [{ filename, lineNo, function: 'crashes', inApp: true }],
  }],
});

test('culpritFrame picks the innermost in-app frame, skipping non-project ones', () => {
  const issue = {
    exceptions: [{
      frames: [
        { filename: 'node_modules/express/lib/router.js', lineNo: 12, inApp: false },
        { filename: 'src/orders.js', lineNo: 6, inApp: true },
      ],
    }],
  };
  const frame = sentryBlame.culpritFrame(issue);
  assert.equal(frame.filename, 'src/orders.js');
  assert.equal(frame.lineNo, 6);
});

test('culpritFrame returns null when nothing is marked inApp', () => {
  const issue = { exceptions: [{ frames: [{ filename: 'lib/x.js', lineNo: 1, inApp: false }] }] };
  assert.equal(sentryBlame.culpritFrame(issue), null);
});

test('candidatePaths tries the full path down to just the filename', () => {
  assert.deepEqual(
    sentryBlame.candidatePaths('/app/src/orders.js'),
    ['app/src/orders.js', 'src/orders.js', 'orders.js']
  );
});

test('matchRosterAuthor prefers the email-local-part/username match over a display-name match', () => {
  const roster = [
    { username: 'second', name: 'اسم دیگری' },
    { username: 'zzz', name: 'Second Person' }, // display name matches, but the email match should win
  ];
  const hit = sentryBlame.matchRosterAuthor({ email: 'second@example.com', name: 'Second Person' }, roster);
  assert.equal(hit.username, 'second');
});

test('matchRosterAuthor falls back to an exact display-name match', () => {
  const roster = [{ username: 'unrelated', name: 'Second Person' }];
  const hit = sentryBlame.matchRosterAuthor({ email: 'someone@else.example', name: 'Second Person' }, roster);
  assert.equal(hit.username, 'unrelated');
});

test('matchRosterAuthor returns null for a git identity nobody on the roster matches', () => {
  const roster = [{ username: 'nope', name: 'Nope' }];
  assert.equal(sentryBlame.matchRosterAuthor({ email: 'ghost@example.com', name: 'Ghost' }, roster), null);
});

test('blameIssue identifies the real author of the crashing line in an actual git repo', async () => {
  const dir = makeRepo();
  try {
    const issue = ISSUE('src/orders.js', 6); // "return undefined.x;"
    const roster = [{ username: 'second', name: 'Second Person' }, { username: 'first', name: 'First Person' }];
    const result = await sentryBlame.blameIssue({ issue, projectPath: dir, roster });
    assert.equal(result.available, true);
    assert.equal(result.author.username, 'second');
    assert.equal(result.gitAuthor.email, 'second@example.com');
    assert.match(result.commit.summary, /add the bug/);
    assert.equal(result.path, 'src/orders.js');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('blameIssue reports the older author for an unrelated line, not the whole file', async () => {
  const dir = makeRepo();
  try {
    const issue = ISSUE('src/orders.js', 2); // "return 1;" — untouched since the first commit
    const roster = [{ username: 'second', name: 'Second Person' }, { username: 'first', name: 'First Person' }];
    const result = await sentryBlame.blameIssue({ issue, projectPath: dir, roster });
    assert.equal(result.available, true);
    assert.equal(result.author.username, 'first');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('blameIssue tries a path prefix Sentry might report before giving up', async () => {
  const dir = makeRepo();
  try {
    // A container-style absolute path — only the "src/orders.js" suffix
    // actually exists in this checkout.
    const issue = ISSUE('/usr/src/app/src/orders.js', 6);
    const result = await sentryBlame.blameIssue({ issue, projectPath: dir, roster: [] });
    assert.equal(result.available, true);
    assert.equal(result.path, 'src/orders.js');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('blameIssue returns available:false, not a throw, for a file that was never in the repo', async () => {
  const dir = makeRepo();
  try {
    const issue = ISSUE('src/does-not-exist.js', 1);
    const result = await sentryBlame.blameIssue({ issue, projectPath: dir, roster: [] });
    assert.equal(result.available, false);
    assert.match(result.reason, /blame ناموفق/);
    assert.ok(result.frame, 'the frame is still surfaced even when blame itself failed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('blameIssue is explicit about a missing PROJECT_PATH rather than silently skipping', async () => {
  const issue = ISSUE('src/orders.js', 6);
  const result = await sentryBlame.blameIssue({ issue, projectPath: '', roster: [] });
  assert.equal(result.available, false);
  assert.match(result.reason, /مسیر چک‌اوت محلی/);
});

test('blameIssue is explicit when the stack trace has no project frame at all', async () => {
  const issue = { exceptions: [{ frames: [{ filename: 'node_modules/x.js', lineNo: 1, inApp: false }] }] };
  const result = await sentryBlame.blameIssue({ issue, projectPath: '/tmp', roster: [] });
  assert.equal(result.available, false);
  assert.equal(result.frame, null);
});

test('parsePorcelain reads author name/mail/time/summary and treats the all-zero sha as "not committed"', () => {
  const zero = '0'.repeat(40);
  const out = [
    `${zero} 1 1 1`,
    'author Not Committed Yet',
    'author-mail <not.committed.yet>',
    'author-time 0',
    'summary local change',
    '\tsome line',
  ].join('\n');
  const parsed = sentryBlame.parsePorcelain(out);
  assert.equal(parsed.sha, null);
});
