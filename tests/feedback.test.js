// lib/feedback.js — the tool's only honest accuracy signal: a 👍/👎 cast on
// a specific finding, keyed by the same fingerprint publish.js dedupes
// comments on.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

function freshFeedback() {
  process.env.CR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-feedback-'));
  delete require.cache[require.resolve('../lib/feedback')];
  return require('../lib/feedback');
}

test('a vote is scoped to its (projectId, mrIid, fingerprint) triple', () => {
  const feedback = freshFeedback();
  feedback.setVote({ projectId: 1, mrIid: 10, fingerprint: 'abc', vote: 'up' });
  feedback.setVote({ projectId: 1, mrIid: 11, fingerprint: 'abc', vote: 'down' });

  assert.deepEqual(feedback.getVotes({ projectId: 1, mrIid: 10 }), { abc: 'up' });
  assert.deepEqual(feedback.getVotes({ projectId: 1, mrIid: 11 }), { abc: 'down' });
});

test('casting null clears a previously cast vote instead of storing it', () => {
  const feedback = freshFeedback();
  feedback.setVote({ projectId: 1, mrIid: 10, fingerprint: 'abc', vote: 'up' });
  feedback.setVote({ projectId: 1, mrIid: 10, fingerprint: 'abc', vote: null });

  assert.deepEqual(feedback.getVotes({ projectId: 1, mrIid: 10 }), {});
});

test('an unrecognized vote value clears rather than stores garbage', () => {
  const feedback = freshFeedback();
  feedback.setVote({ projectId: 1, mrIid: 10, fingerprint: 'abc', vote: 'up' });
  feedback.setVote({ projectId: 1, mrIid: 10, fingerprint: 'abc', vote: 'sideways' });

  assert.deepEqual(feedback.getVotes({ projectId: 1, mrIid: 10 }), {}, 'an invalid vote acts as a clear, not a silent no-op keeping the old vote');
});

test('accuracy() rate counts only findings someone actually voted on', () => {
  const feedback = freshFeedback();
  feedback.setVote({ projectId: 1, mrIid: 1, fingerprint: 'a', vote: 'up', category: 'security' });
  feedback.setVote({ projectId: 1, mrIid: 1, fingerprint: 'b', vote: 'up', category: 'security' });
  feedback.setVote({ projectId: 1, mrIid: 1, fingerprint: 'c', vote: 'down', category: 'style' });

  const acc = feedback.accuracy();
  assert.equal(acc.total, 3);
  assert.equal(acc.up, 2);
  assert.equal(acc.down, 1);
  assert.equal(acc.rate, 67, 'rounds to the nearest percent');
});

test('an empty vote log reports a null rate, not a divide-by-zero or 0%', () => {
  const feedback = freshFeedback();
  const acc = feedback.accuracy();
  assert.equal(acc.total, 0);
  assert.equal(acc.rate, null, 'no votes cast is "no data", not "0% accurate"');
  assert.deepEqual(acc.byCategory, []);
});

test('accuracy() breaks down per category, each with its own rate', () => {
  const feedback = freshFeedback();
  feedback.setVote({ projectId: 1, mrIid: 1, fingerprint: 'a', vote: 'up', category: 'security' });
  feedback.setVote({ projectId: 1, mrIid: 1, fingerprint: 'b', vote: 'down', category: 'security' });
  feedback.setVote({ projectId: 1, mrIid: 1, fingerprint: 'c', vote: 'up', category: 'style' });

  const acc = feedback.accuracy();
  const byCat = Object.fromEntries(acc.byCategory.map((c) => [c.category, c]));
  assert.equal(byCat.security.rate, 50);
  assert.equal(byCat.style.rate, 100);
});
