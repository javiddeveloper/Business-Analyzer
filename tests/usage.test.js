// lib/usage.js — model usage accounting. The point of this file existing at
// all is "how much are we spending", so these tests check the arithmetic a
// dashboard would show, not just that records land on disk.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const DAY = 86400000;

// Each test gets its own data dir and a freshly-required module — usage.js
// keeps no in-memory state, but the file it reads/writes is process-wide, so
// sharing one dir across tests would let an earlier test's records leak into
// a later test's window/day arithmetic.
function freshUsage() {
  process.env.CR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-usage-'));
  delete require.cache[require.resolve('../lib/usage')];
  return require('../lib/usage');
}

test('summary totals tokens and review count across providers', () => {
  const usage = freshUsage();
  const now = Date.now();
  usage.record({ projectId: 1, mrIid: 10, provider: 'openai-compatible', mode: 'batch', promptTokens: 1000, completionTokens: 200, at: now });
  usage.record({ projectId: 1, mrIid: 11, provider: 'claude-cli', mode: 'agent', promptTokens: 500, completionTokens: 50, at: now });

  const s = usage.summary({ now });
  assert.equal(s.reviews, 2);
  assert.equal(s.promptTokens, 1500);
  assert.equal(s.completionTokens, 250);
  assert.equal(s.totalTokens, 1750);

  const byProvider = Object.fromEntries(s.byProvider.map((p) => [p.provider, p]));
  assert.equal(byProvider['openai-compatible'].reviews, 1);
  assert.equal(byProvider['openai-compatible'].totalTokens, 1200);
  assert.equal(byProvider['claude-cli'].totalTokens, 550);
});

test('today is a subset of the window, keyed by UTC calendar day', () => {
  const usage = freshUsage();
  const now = Date.now();
  usage.record({ provider: 'gemini', mode: 'batch', promptTokens: 100, completionTokens: 10, at: now });
  usage.record({ provider: 'gemini', mode: 'batch', promptTokens: 300, completionTokens: 30, at: now - 2 * DAY });

  const s = usage.summary({ now, days: 30 });
  assert.equal(s.reviews, 2, 'both records are inside the 30-day window');
  assert.equal(s.today.reviews, 1, 'only the same-day record counts as today');
  assert.equal(s.today.totalTokens, 110);
});

test('the days window excludes records older than it, not just the count', () => {
  const usage = freshUsage();
  const now = Date.now();
  usage.record({ provider: 'gemini', mode: 'batch', promptTokens: 1, completionTokens: 1, at: now });
  usage.record({ provider: 'gemini', mode: 'batch', promptTokens: 999, completionTokens: 999, at: now - 40 * DAY });

  const s = usage.summary({ now, days: 7 });
  assert.equal(s.reviews, 1, 'the 40-day-old record falls outside a 7-day window');
  assert.equal(s.totalTokens, 2);
});

test('an empty log summarizes to all zeros, not an error', () => {
  const usage = freshUsage();
  const s = usage.summary();
  assert.equal(s.reviews, 0);
  assert.equal(s.totalTokens, 0);
  assert.deepEqual(s.byProvider, []);
});
