// Committing review/MR-<iid>.md onto the merge request's own branch.
//
// Before this, the report was only ever written into PROJECT_PATH — a local
// checkout that is normally sitting on some other branch — so the file never
// reached the merge request it describes unless a human committed it by hand.
const test = require('node:test');
const assert = require('node:assert');

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

function freshGitlab() {
  stub('../lib/ai_bridge', {
    secret: (k) => (k === 'GITLAB_URL' ? 'https://example.test' : k === 'GITLAB_TOKEN' ? 'tok' : ''),
  });
  delete require.cache[require.resolve('../lib/gitlab')];
  return require('../lib/gitlab');
}

// Records every request so the assertions can be about what GitLab was
// actually asked to do, not just about what the function returned.
function captureFetch(handler) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    return handler(String(url), opts);
  };
  return calls;
}

const ok = (json = {}) => ({ ok: true, status: 200, text: async () => JSON.stringify(json) });
const notFound = { ok: false, status: 404, text: async () => JSON.stringify({ message: '404 File Not Found' }) };

test('the commit targets the MR branch, at the repo-relative path, with the exact content', async () => {
  const gitlab = freshGitlab();
  const original = global.fetch;
  const calls = captureFetch(() => ok({ id: 'sha1' }));
  try {
    await gitlab.commitFile(7, {
      branch: 'feature/EM-1',
      filePath: 'review/MR-12.md',
      content: '# گزارش\nمتن',
      message: 'review: report',
      action: 'create',
    });
  } finally { global.fetch = original; }

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/projects\/7\/repository\/commits$/);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body.branch, 'feature/EM-1');
  assert.deepEqual(calls[0].body.actions, [
    { action: 'create', file_path: 'review/MR-12.md', content: '# گزارش\nمتن' },
  ]);
});

// GitLab answers 400 for "create" on a path that already exists, so the
// second review of the same MR would fail every time if this were guessed.
test('fileExistsOnBranch tells create from update, and reads a 404 as "not there"', async () => {
  const gitlab = freshGitlab();
  const original = global.fetch;
  try {
    captureFetch(() => ok({ file_name: 'MR-12.md' }));
    assert.equal(await gitlab.fileExistsOnBranch(7, 'feature/EM-1', 'review/MR-12.md'), true);

    captureFetch(() => notFound);
    assert.equal(await gitlab.fileExistsOnBranch(7, 'feature/EM-1', 'review/MR-12.md'), false);
  } finally { global.fetch = original; }
});

// A 500 is not "the file isn't there". Treating it as one would send a
// "create" for a path that does exist, which GitLab then rejects — turning a
// transient outage into a permanent-looking push failure.
test('a non-404 failure is thrown rather than read as a missing file', async () => {
  const gitlab = freshGitlab();
  const original = global.fetch;
  try {
    captureFetch(() => ({ ok: false, status: 500, text: async () => 'boom' }));
    await assert.rejects(() => gitlab.fileExistsOnBranch(7, 'b', 'review/MR-12.md'), /500/);
  } finally { global.fetch = original; }
});

test('the file path sent to GitLab is repo-relative and slash-separated on every OS', () => {
  delete require.cache[require.resolve('../lib/reportFile')];
  const reportFile = require('../lib/reportFile');
  assert.equal(reportFile.reportRelPath(12), 'review/MR-12.md');
  assert.ok(!reportFile.reportRelPath(12).includes('\\'), 'a Windows separator here would create a file literally named "review\\MR-12.md"');
});
