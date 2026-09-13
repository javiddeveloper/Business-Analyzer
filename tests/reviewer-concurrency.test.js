// lib/reviewer.js: the batch cap (raised from 8 to 24 now that claude-cli
// is subscription-based, not billed per token) and the worker-pool that
// paces those calls instead of firing all of them at once.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.CR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-reviewer-conc-'));

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const { mapWithConcurrency, MAX_BATCHES, BATCH_CONCURRENCY } = require('../lib/reviewer');

test('mapWithConcurrency never runs more than `limit` items at once and preserves result order', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const items = Array.from({ length: 15 }, (_, i) => i);

  const results = await mapWithConcurrency(items, 4, async (n) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5 + (n % 3))); // uneven durations
    inFlight--;
    return n * 10;
  });

  assert.ok(maxInFlight <= 4, `saw ${maxInFlight} concurrent, expected <= 4`);
  assert.equal(maxInFlight, 4, 'a full queue should actually use all 4 slots, not under-run them');
  assert.deepEqual(results, items.map((n) => n * 10), 'results line up with input order regardless of finish order');
});

test('mapWithConcurrency propagates a rejection without hanging', async () => {
  await assert.rejects(
    () => mapWithConcurrency([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error('boom'); return n; }),
    /boom/
  );
});

test('review() covers far more than the old 8-batch cap in one run', async () => {
  // Each file has to fill a batch on its own, otherwise buildBatches packs
  // them all into two batches and the cap is never approached — the point here
  // is to exceed the OLD 8-batch cap. The per-file size comes from the live
  // budget: it used to be a literal 13000, which stopped filling a batch the
  // moment the cap became a function of the engine's context window
  // (lib/contextBudget.js) and quietly turned this into a 2-call test.
  //
  // ai_bridge is stubbed *before* budgetFor() runs, with a fixed AI_PROVIDER,
  // so this test's notion of "big enough to fill a batch" always matches what
  // reviewer.review() actually uses underneath. contextBudget.secret() does a
  // lazy require('./ai_bridge') on every call rather than caching it at
  // module load, so it picks up this stub too — leaving it real (reading
  // secrets.env on whichever machine runs the suite) previously meant the
  // size computed here and the size review() batched against could come from
  // two different engines' context windows, which is exactly what turned this
  // into a flaky test: it passed or failed depending on which AI_PROVIDER was
  // configured locally, never on a code regression.
  let calls = 0;
  let maxConcurrent = 0;
  let concurrent = 0;
  stub('../lib/ai_bridge', {
    secret: (key) => (key === 'AI_PROVIDER' ? 'openai-compatible' : ''),
    async callModel() {
      calls++;
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      concurrent--;
      return { text: JSON.stringify({ summary: 'ok', findings: [], positives: [] }), usage: { promptTokens: 1, completionTokens: 1 } };
    },
  });

  delete require.cache[require.resolve('../lib/contextBudget')];
  const budget = require('../lib/contextBudget').budgetFor();
  const perFile = budget.fileDiffChars + 1000;
  const changes = Array.from({ length: 20 }, (_, i) => ({
    old_path: `f${i}.kt`, new_path: `f${i}.kt`,
    diff: `@@ -1,0 +1,3 @@\n+line one for file ${i}\n+${'x'.repeat(perFile)}\n+line three`,
  }));

  const reviewer = freshReviewer();
  const result = await reviewer.review({ mr: { title: 't' }, changes });

  assert.ok(calls > 8, `expected more than the old 8-batch cap, got ${calls} calls`);
  assert.equal(result.stats.batches, calls);
  assert.ok(maxConcurrent <= BATCH_CONCURRENCY, `saw ${maxConcurrent} concurrent model calls, expected <= ${BATCH_CONCURRENCY}`);
  assert.equal(result.findings.some((f) => /سقف حجم/.test(f.title)), false, 'all 40 files fit under the new cap — nothing should be reported as dropped');
});

function freshReviewer() {
  delete require.cache[require.resolve('../lib/reviewer')];
  return require('../lib/reviewer');
}
