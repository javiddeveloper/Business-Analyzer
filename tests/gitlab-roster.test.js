// Two things fixed together: apiFetch's missing timeout (a single stalled
// GitLab connection was hanging the whole developer-analytics request
// indefinitely — this project has seen exactly that kind of network blip
// more than once), and the roster being filtered down to actual Developer
// role members (not Maintainers/Owners, who are running the project, not
// being reviewed).
const test = require('node:test');
const assert = require('node:assert');

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

function freshGitlab() {
  delete require.cache[require.resolve('../lib/gitlab')];
  return require('../lib/gitlab');
}

test('apiFetch times out instead of hanging forever on a stalled connection', async () => {
  stub('../lib/ai_bridge', {
    secret: (k) => (k === 'GITLAB_URL' ? 'https://example.test' : k === 'GITLAB_TOKEN' ? 't' : ''),
  });
  const originalFetch = global.fetch;
  // Simulates a connection that never resolves and never rejects on its own —
  // exactly what a stalled TCP connection looks like from fetch's perspective.
  global.fetch = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    });
  });
  try {
    const gitlab = freshGitlab();
    const start = Date.now();
    await assert.rejects(
      () => gitlab.getCurrentUser({ timeoutMs: 50 }),
      /timeout after 0\.05s/
    );
    assert.ok(Date.now() - start < 2000, 'must fail fast, not hang for the default 15s+');
  } finally {
    global.fetch = originalFetch;
  }
});

test('listAllAuthors keeps only Developer-role members when a project id is set', async () => {
  stub('../lib/ai_bridge', {
    secret: (k) => (k === 'GITLAB_PROJECT_ID' ? '99' : k === 'GITLAB_URL' ? 'https://example.test' : ''),
  });
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/merge_requests')) {
      return {
        ok: true,
        text: async () => JSON.stringify([
          { author: { username: 'dev1', name: 'Dev One' } },
          { author: { username: 'maintainer1', name: 'Maintainer One' } },
          { author: { username: 'owner1', name: 'Owner One' } },
        ]),
      };
    }
    if (u.includes('/members/all')) {
      return {
        ok: true,
        text: async () => JSON.stringify([
          { username: 'dev1', access_level: 30 },
          { username: 'maintainer1', access_level: 40 },
          { username: 'owner1', access_level: 50 },
        ]),
      };
    }
    throw new Error('unexpected fetch: ' + u);
  };
  try {
    const gitlab = freshGitlab();
    const authors = await gitlab.listAllAuthors();
    assert.deepEqual(authors.map((a) => a.username), ['dev1']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('listAllAuthors returns everyone unfiltered when there is no project id to look up roles in', async () => {
  stub('../lib/ai_bridge', {
    secret: (k) => (k === 'GITLAB_URL' ? 'https://example.test' : ''), // no GITLAB_PROJECT_ID
  });
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    text: async () => JSON.stringify([
      { author: { username: 'dev1', name: 'Dev One' } },
      { author: { username: 'maintainer1', name: 'Maintainer One' } },
    ]),
  });
  try {
    const gitlab = freshGitlab();
    const authors = await gitlab.listAllAuthors();
    assert.deepEqual(authors.map((a) => a.username).sort(), ['dev1', 'maintainer1']);
  } finally {
    global.fetch = originalFetch;
  }
});
