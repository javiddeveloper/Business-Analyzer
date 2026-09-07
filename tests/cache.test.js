// lib/cache.js: the TTL cache the developer analytics page relies on to not
// re-pay a 15+ second GitLab crawl on every click.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.CR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-cache-'));
const { cached, invalidate } = require('../lib/cache');

test('a miss computes and caches; a hit within the TTL does not recompute', async () => {
  let calls = 0;
  const compute = async () => { calls++; return { n: calls }; };

  const first = await cached('t1', 'k', 60000, compute);
  assert.equal(first.fromCache, false);
  assert.equal(first.value.n, 1);

  const second = await cached('t1', 'k', 60000, compute);
  assert.equal(second.fromCache, true);
  assert.equal(second.value.n, 1, 'compute must not run again on a hit');
  assert.equal(calls, 1);
});

test('an expired entry (ttl elapsed) recomputes', async () => {
  let calls = 0;
  const compute = async () => { calls++; return calls; };

  await cached('t2', 'k', 10, compute);
  await new Promise((r) => setTimeout(r, 30));
  const after = await cached('t2', 'k', 10, compute);

  assert.equal(after.fromCache, false);
  assert.equal(calls, 2);
});

test('force bypasses a still-fresh cache entry', async () => {
  let calls = 0;
  const compute = async () => { calls++; return calls; };

  await cached('t3', 'k', 60000, compute);
  const forced = await cached('t3', 'k', 60000, compute, { force: true });

  assert.equal(forced.fromCache, false);
  assert.equal(calls, 2);
  // ...and the forced result is now what a normal (non-forced) read sees.
  const after = await cached('t3', 'k', 60000, compute);
  assert.equal(after.fromCache, true);
  assert.equal(after.value, 2);
});

test('different keys under the same cache name do not collide', async () => {
  await cached('t4', 'a', 60000, async () => 'A');
  await cached('t4', 'b', 60000, async () => 'B');
  const a = await cached('t4', 'a', 60000, async () => 'should not run');
  const b = await cached('t4', 'b', 60000, async () => 'should not run');
  assert.equal(a.value, 'A');
  assert.equal(b.value, 'B');
});

test('invalidate(name, key) forces the next read to recompute; other keys survive', async () => {
  let calls = 0;
  await cached('t5', 'x', 60000, async () => { calls++; return calls; });
  await cached('t5', 'y', 60000, async () => 'Y');

  invalidate('t5', 'x');
  const x = await cached('t5', 'x', 60000, async () => { calls++; return calls; });
  const y = await cached('t5', 'y', 60000, async () => 'should not run');

  assert.equal(x.fromCache, false);
  assert.equal(calls, 2);
  assert.equal(y.value, 'Y', 'invalidating one key must not touch another');
});

test('invalidate(name) with no key clears the whole cache', async () => {
  await cached('t6', 'a', 60000, async () => 'A');
  await cached('t6', 'b', 60000, async () => 'B');
  invalidate('t6');
  const a = await cached('t6', 'a', 60000, async () => 'recomputed-a');
  assert.equal(a.fromCache, false);
  assert.equal(a.value, 'recomputed-a');
});
