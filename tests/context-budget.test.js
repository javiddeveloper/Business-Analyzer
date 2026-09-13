// How much of the code actually reaches the model, and who decides.
//
// The regression these guard against: every size cap in the review path used
// to be a literal number that was the same for a 32K-token router and a
// 1M-token Gemini, and everything cut was cut silently — the review looked
// complete whether the model had seen the file or the first 4000 characters
// of it.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.CR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-budget-'));

// secrets.env is read through fs on every lookup (ai_bridge.secret), so
// controlling readFileSync is enough to pin which engine is active and which
// overrides are on file — the same trick tests/engine-fallback.test.js uses.
function withSecrets(env, fn) {
  const bridgePath = require.resolve('../lib/ai_bridge');
  const budgetPath = require.resolve('../lib/contextBudget');
  delete require.cache[bridgePath];
  delete require.cache[budgetPath];
  const originalRead = fs.readFileSync;
  const body = Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n');
  fs.readFileSync = (p, ...rest) => (String(p).endsWith('secrets.env') ? body : originalRead(p, ...rest));
  try {
    return fn(require('../lib/contextBudget'));
  } finally {
    fs.readFileSync = originalRead;
    delete require.cache[bridgePath];
    delete require.cache[budgetPath];
  }
}

// ---- the estimate ------------------------------------------------------

test('the token estimate counts Persian far heavier than Latin code, which a character count never did', () => {
  const budget = require('../lib/contextBudget');
  const latin = 'const x = compute(a, b); // plain source code';
  const persian = 'هر مهاجرت باید برگشت‌پذیر باشد و تست داشته باشد.';

  assert.ok(budget.estimateTokens(latin) < latin.length / 3, 'latin code packs several characters per token');
  assert.ok(
    budget.estimateTokens(persian) > persian.length / 2,
    'Persian text is roughly one token per character — treating it like code under-counts it badly'
  );
  assert.equal(budget.estimateTokens(''), 0);
  assert.equal(budget.estimateTokens(null), 0);
});

// ---- per-engine budgets ------------------------------------------------

test('each engine gets a budget from its own context window, not one shared number', () => {
  const claude = withSecrets({ AI_PROVIDER: 'claude-cli' }, (b) => b.budgetFor());
  const router = withSecrets({ AI_PROVIDER: '9router' }, (b) => b.budgetFor());
  const gemini = withSecrets({ AI_PROVIDER: 'gemini' }, (b) => b.budgetFor());

  assert.equal(claude.contextTokens, 200000);
  assert.equal(router.contextTokens, 32000, '9Router may route to any model it fronts — assume the smallest window');
  assert.equal(gemini.contextTokens, 1000000);

  assert.ok(router.batchChars < claude.batchChars, 'a 32K router must be sent less code than Claude');
  assert.ok(claude.knowledgeChars > router.knowledgeChars);
  assert.ok(gemini.batchChars >= claude.batchChars);
});

test('an unknown or unset provider falls back to the conservative default rather than throwing', () => {
  const unknown = withSecrets({ AI_PROVIDER: 'something-else' }, (b) => b.budgetFor());
  const unset = withSecrets({}, (b) => b.budgetFor());
  assert.equal(unknown.provider, 'openai-compatible');
  assert.equal(unset.provider, 'openai-compatible');
});

test('the prompt budget always leaves room for the answer and stays inside the window', () => {
  for (const provider of ['claude-cli', 'openai-compatible', '9router', 'gemini']) {
    const b = withSecrets({ AI_PROVIDER: provider }, (m) => m.budgetFor());
    assert.ok(b.promptTokens + b.maxOutputTokens < b.contextTokens, `${provider}: prompt+output must fit the window`);
    assert.ok(b.maxOutputTokens >= 512, `${provider}: an output cap below 512 tokens can't hold a review's JSON`);
    assert.ok(b.batchChars >= 8000, `${provider}: a batch too small to hold a file is useless`);
  }
});

test('secrets.env overrides the catalog — globally, and per engine with the engine winning', () => {
  const global = withSecrets({ AI_PROVIDER: '9router', REVIEW_CONTEXT_TOKENS: '100000' }, (b) => b.budgetFor());
  assert.equal(global.contextTokens, 100000);

  const perEngine = withSecrets(
    { AI_PROVIDER: '9router', REVIEW_CONTEXT_TOKENS: '100000', NINEROUTER_CONTEXT_TOKENS: '64000' },
    (b) => b.budgetFor()
  );
  assert.equal(perEngine.contextTokens, 64000, 'the engine-specific key is the more specific answer');

  const garbage = withSecrets({ AI_PROVIDER: '9router', REVIEW_CONTEXT_TOKENS: 'lots' }, (b) => b.budgetFor());
  assert.equal(garbage.contextTokens, 32000, 'an unparseable override is ignored, not treated as zero');

  const output = withSecrets({ AI_PROVIDER: 'gemini', REVIEW_MAX_OUTPUT_TOKENS: '16000' }, (b) => b.budgetFor());
  assert.equal(output.maxOutputTokens, 16000);
});

test('an override cannot make the output cap eat the whole window', () => {
  const b = withSecrets({ AI_PROVIDER: '9router', REVIEW_MAX_OUTPUT_TOKENS: '900000' }, (m) => m.budgetFor());
  assert.ok(b.maxOutputTokens <= b.contextTokens / 4);
  assert.ok(b.promptTokens > 0);
});

// ---- overflow is detected, not discovered by an HTTP 400 ---------------

test('checkPrompt flags a prompt that cannot fit, and passes one that can', () => {
  const small = withSecrets({ AI_PROVIDER: '9router' }, (b) =>
    b.checkPrompt({ system: 'role', user: 'diff', provider: '9router' })
  );
  assert.equal(small.overflow, false);

  const huge = withSecrets({ AI_PROVIDER: '9router' }, (b) =>
    b.checkPrompt({ system: 'role', user: 'x'.repeat(2000000), provider: '9router' })
  );
  assert.equal(huge.overflow, true);
  assert.ok(huge.tokens > huge.limit);
});

test('callModel refuses an over-budget prompt with a Persian error instead of letting the endpoint 400', async () => {
  const bridgePath = require.resolve('../lib/ai_bridge');
  const budgetPath = require.resolve('../lib/contextBudget');
  delete require.cache[bridgePath];
  delete require.cache[budgetPath];
  const originalRead = fs.readFileSync;
  const originalFetch = global.fetch;
  fs.readFileSync = (p, ...rest) =>
    (String(p).endsWith('secrets.env') ? 'AI_PROVIDER=9router\nNINEROUTER_API_KEY=k' : originalRead(p, ...rest));
  global.fetch = () => { throw new Error('no request may be sent for a prompt that cannot fit'); };
  try {
    const bridge = require('../lib/ai_bridge');
    const result = await bridge.callModel({ system: 'role', user: 'x'.repeat(2000000) });
    assert.equal(result.overflow, true);
    assert.match(result.error, /سقف context/);
    assert.ok(result.estimatedPromptTokens > result.promptTokenLimit);
  } finally {
    fs.readFileSync = originalRead;
    global.fetch = originalFetch;
    delete require.cache[bridgePath];
    delete require.cache[budgetPath];
  }
});

test('the default output length is the engine\'s, not one hardcoded 4000 for everyone', () => {
  const router = withSecrets({ AI_PROVIDER: '9router' }, (b) => b.budgetFor().maxOutputTokens);
  const claude = withSecrets({ AI_PROVIDER: 'claude-cli' }, (b) => b.budgetFor().maxOutputTokens);
  assert.notEqual(router, claude);
});

// ---- fit(): cut, and say so -------------------------------------------

test('fit leaves a short text alone and marks a long one in Persian', () => {
  const budget = require('../lib/contextBudget');
  const short = budget.fit('abc', 100);
  assert.equal(short.text, 'abc');
  assert.equal(short.truncated, false);

  const long = budget.fit('x'.repeat(50), 10);
  assert.equal(long.truncated, true);
  assert.equal(long.droppedChars, 40);
  assert.match(long.text, /حذف شد/, 'the marker travels with the text, so the model sees the cut too');
});
