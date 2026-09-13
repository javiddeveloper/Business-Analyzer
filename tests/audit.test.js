// lib/audit.js — the trail for who changed settings/env/projects and every
// auto-approve, given this project has no user accounts to attribute them to.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

function freshAudit() {
  process.env.CR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-audit-'));
  delete require.cache[require.resolve('../lib/audit')];
  return require('../lib/audit');
}

test('list() returns newest first', () => {
  const audit = freshAudit();
  audit.record({ action: 'settings', actor: 'local', detail: { a: 1 }, at: 1000 });
  audit.record({ action: 'env', actor: 'local', detail: { keys: ['X'] }, at: 2000 });

  const entries = audit.list();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].action, 'env', 'the later record comes first');
  assert.equal(entries[1].action, 'settings');
});

test('list() can filter to one action', () => {
  const audit = freshAudit();
  audit.record({ action: 'settings', actor: 'local', at: 1 });
  audit.record({ action: 'approve', actor: 'auto', at: 2 });
  audit.record({ action: 'approve', actor: 'webhook', at: 3 });

  const entries = audit.list({ action: 'approve' });
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.action === 'approve'));
});

test('list() respects the limit, keeping the newest entries', () => {
  const audit = freshAudit();
  for (let i = 0; i < 10; i++) audit.record({ action: 'settings', actor: 'local', at: i });

  const entries = audit.list({ limit: 3 });
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.at), [9, 8, 7]);
});

test('an actor is never silently dropped, even when not given', () => {
  const audit = freshAudit();
  audit.record({ action: 'approve', detail: { mrIid: 1 } });
  assert.equal(audit.list()[0].actor, 'unknown');
});

test('an empty log returns an empty list, not an error', () => {
  const audit = freshAudit();
  assert.deepEqual(audit.list(), []);
});
