// One place that answers "how much text may this review send to the model?".
//
// Why this file exists: the size caps were previously literal numbers spread
// across four modules (a 6000-char knowledge cap, a 4000-char Jira
// description cap, a 4000-char full-file cap, a 14000-char batch cap, a hard
// `maxTokens || 4000`), and none of them corresponded to any real model
// context window. The practical effect was that Gemini (a 1M-token window)
// and a local 9Router "combo" (whatever the smallest model behind it is)
// were handed exactly the same amount of code — far too little for one, and
// potentially too much for the other, with the overflow only ever showing up
// as an HTTP 400 from the endpoint.
//
// So: every cap is derived here from the *active engine's* context window,
// with per-engine and global overrides read through the same secrets.env /
// secret() convention as the rest of the project.
//
// The require of ai_bridge is deliberately lazy (inside the function, not at
// module scope): ai_bridge itself asks this module for its default output
// length, and a top-level require in both directions would hand one of them
// a half-initialised `module.exports`.
function secret(key) {
  try {
    return require('./ai_bridge').secret(key) || '';
  } catch (e) {
    return process.env[key] || '';
  }
}

// Published context windows, in tokens, for the engines this project can
// actually talk to. These are input+output windows, not marketing numbers:
//  - claude-cli: Claude Sonnet/Opus via the CLI — 200K.
//  - openai-compatible: the GapGPT default is gpt-4o-mini — 128K. Any other
//    OpenAI-compatible model behind the same base URL is usually >= this, so
//    it is the safe assumption rather than the optimistic one.
//  - 9router: a multi-model router; the request may land on *any* model it
//    fronts, so the budget has to assume the smallest common window (32K)
//    instead of the largest.
//  - gemini: gemini-2.0-flash — 1M. Deliberately not spent in full; see
//    WINDOW_USE below.
const ENGINE_LIMITS = {
  'claude-cli': { contextTokens: 200000, maxOutputTokens: 8000, contextEnv: 'CLAUDE_CONTEXT_TOKENS', outputEnv: 'CLAUDE_MAX_OUTPUT_TOKENS' },
  'openai-compatible': { contextTokens: 128000, maxOutputTokens: 8000, contextEnv: 'AI_CONTEXT_TOKENS', outputEnv: 'AI_MAX_OUTPUT_TOKENS' },
  '9router': { contextTokens: 32000, maxOutputTokens: 4000, contextEnv: 'NINEROUTER_CONTEXT_TOKENS', outputEnv: 'NINEROUTER_MAX_OUTPUT_TOKENS' },
  gemini: { contextTokens: 1000000, maxOutputTokens: 8000, contextEnv: 'GEMINI_CONTEXT_TOKENS', outputEnv: 'GEMINI_MAX_OUTPUT_TOKENS' },
};
const DEFAULT_ENGINE = 'openai-compatible';

// Only this fraction of the window is ever filled. The estimate below is an
// approximation of somebody else's tokenizer, the role prompt and the JSON
// instructions ride along on every call, and an endpoint that rejects an
// over-long prompt costs a whole batch — so the headroom is worth more than
// the extra code it would buy.
const WINDOW_USE = 0.7;

// Characters per token, split by script, because a single ratio is wrong for
// this project by a factor of three. Latin source code sits around 3.6
// chars/token on BPE tokenizers; Persian/Arabic text (the role prompt, the
// knowledge base, Jira descriptions — all Persian here) is far denser,
// roughly one token per 1.2 characters once UTF-8 multibyte sequences are
// split. Counting raw characters, as this codebase used to, silently assumed
// the Latin ratio for Persian text.
const CHARS_PER_TOKEN_ASCII = 3.6;
const CHARS_PER_TOKEN_WIDE = 1.2;

// An approximate token count. Not a tokenizer — deliberately: a real one is a
// dependency, and this project has none. It is calibrated to over-estimate
// rather than under-estimate, since the failure mode of guessing low is a
// rejected request.
function estimateTokens(text) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  let wide = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) wide++;
  }
  const ascii = s.length - wide;
  return Math.ceil(ascii / CHARS_PER_TOKEN_ASCII + wide / CHARS_PER_TOKEN_WIDE);
}

// Inverse of the estimate, for turning a token budget into the character cap
// the truncating code actually needs. Uses the Latin ratio on purpose: the
// text being cut by a character cap is source code, and assuming the denser
// Persian ratio here would waste most of the window.
function tokensToChars(tokens) {
  return Math.max(0, Math.floor(tokens * CHARS_PER_TOKEN_ASCII));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function positiveInt(raw) {
  const n = parseInt(String(raw || '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizeProvider(provider) {
  const id = String(provider || '').toLowerCase();
  if (ENGINE_LIMITS[id]) return id;
  return '';
}

// The engine a budget is computed for: an explicit argument (a review that
// fell back to a second engine passes one) beats the configured AI_PROVIDER.
function activeProvider(provider) {
  return normalizeProvider(provider) || normalizeProvider(secret('AI_PROVIDER')) || DEFAULT_ENGINE;
}

// Every cap the review path needs, derived from one engine's window.
//
// The per-section shares are proportions of the prompt budget, then clamped:
// the floors keep a small-window engine from getting a budget too small to
// review anything at all, and the ceilings stop a 1M-token engine from being
// handed a megabyte of diff in one call — which would be slow, expensive and
// worse-reviewed than the same code split into batches.
function budgetFor(provider) {
  const id = activeProvider(provider);
  const engine = ENGINE_LIMITS[id];

  const contextTokens = positiveInt(secret(engine.contextEnv)) || positiveInt(secret('REVIEW_CONTEXT_TOKENS')) || engine.contextTokens;
  const requestedOutput = positiveInt(secret(engine.outputEnv)) || positiveInt(secret('REVIEW_MAX_OUTPUT_TOKENS')) || engine.maxOutputTokens;
  // Output can never be allowed to eat the window it shares with the prompt.
  const maxOutputTokens = clamp(requestedOutput, 512, Math.max(512, Math.floor(contextTokens / 4)));

  const promptTokens = Math.max(1500, Math.floor(contextTokens * WINDOW_USE) - maxOutputTokens);
  const promptChars = tokensToChars(promptTokens);

  const batchChars = clamp(promptChars * 0.55, 8000, 120000);
  const fileDiffChars = clamp(batchChars * 0.6, 6000, 60000);
  const fullFileChars = clamp(batchChars * 0.35, 3000, 40000);

  return {
    provider: id,
    contextTokens,
    maxOutputTokens,
    promptTokens,
    promptChars,
    // One model call's worth of diff+context (the reviewer's batch packing).
    batchChars,
    // A single file's annotated diff inside a batch.
    fileDiffChars,
    // A single file's full text pulled from the local checkout.
    fullFileChars,
    // All full-file context for one MR together. A batch carries only a
    // slice of it, but reading twenty megabytes off disk to throw it away is
    // still waste, so the loader is bounded too.
    fullFileTotalChars: clamp(fullFileChars * 20, 20000, 600000),
    // Team standards folded into every system prompt.
    knowledgeChars: clamp(promptChars * 0.08, 2000, 24000),
    // The Jira ticket text that lets a review judge intent.
    jiraDescriptionChars: clamp(promptChars * 0.04, 1500, 12000),
    // The MR's own description.
    mrDescriptionChars: clamp(promptChars * 0.02, 800, 6000),
  };
}

// Truncate to a character cap and say so, instead of returning a shortened
// string that looks complete. `marker` is Persian because it is read by the
// model *and* quoted in the review report.
function fit(text, maxChars, marker) {
  const s = String(text == null ? '' : text);
  if (!maxChars || s.length <= maxChars) return { text: s, truncated: false, droppedChars: 0 };
  const kept = s.slice(0, maxChars);
  const droppedChars = s.length - maxChars;
  const note = marker || `\n[... ${droppedChars} کاراکتر به دلیل سقف حجم context حذف شد ...]`;
  return { text: kept + note, truncated: true, droppedChars };
}

// Does this prompt fit the engine at all? The batch path had no answer to
// this question before: an over-long batch was simply sent, and came back as
// an opaque HTTP 400 that the report showed as "خطای مدل".
function checkPrompt({ system, user, provider }) {
  const budget = budgetFor(provider);
  const tokens = estimateTokens(system) + estimateTokens(user);
  return {
    tokens,
    limit: budget.promptTokens,
    provider: budget.provider,
    overflow: tokens > budget.promptTokens,
  };
}

// One line for the review report / logs, so the numbers a review ran under
// are visible rather than implied.
function describe(provider) {
  const b = budgetFor(provider);
  return `موتور ${b.provider}: پنجره‌ی context حدود ${b.contextTokens} توکن، سقف ورودی هر درخواست ${b.promptTokens} توکن، سقف خروجی ${b.maxOutputTokens} توکن.`;
}

module.exports = {
  ENGINE_LIMITS,
  WINDOW_USE,
  estimateTokens,
  tokensToChars,
  budgetFor,
  fit,
  checkPrompt,
  describe,
};
