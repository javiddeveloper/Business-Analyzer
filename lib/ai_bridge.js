// Minimal AI bridge — adapted from business-generator-light's agent_bridge.js
// (same secrets.env convention, same fetchWithRetry pattern): an
// OpenAI-compatible chat/completions endpoint (GapGPT, OpenAI, Ollama, a
// local multi-model proxy, …), Gemini's native API, and a Claude CLI engine
// for people reviewing off their Claude Code subscription instead of an API
// key (also ported from business-generator's Windows .cmd-shim handling).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SECRETS_PATH = path.join(ROOT, 'secrets.env');

function secret(key) {
  try {
    const raw = fs.readFileSync(SECRETS_PATH, 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i < 0 || t.slice(0, i).trim() !== key) continue;
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      return v;
    }
  } catch (e) {}
  return process.env[key] || '';
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Required lazily (and through the module object, not a destructured
// binding): contextBudget reads secrets through `secret` above, so the two
// modules reference each other. A lazy call-time require means whichever one
// is loaded first is fully initialised before the other reads from it.
function budgetFor(provider) {
  return require('./contextBudget').budgetFor(provider);
}

// The output cap an engine gets when the caller doesn't name one. This used
// to be a literal `maxTokens || 4000` in both HTTP engines — the same number
// for a 32K router and a 1M-token Gemini.
function defaultMaxTokens(provider) {
  return budgetFor(provider).maxOutputTokens;
}

async function fetchWithRetry(url, options, maxRetries = 3) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429 || res.status >= 500) {
        attempt++;
        if (attempt >= maxRetries) return res;
        const delay = attempt * 2500;
        console.error(`[ai-bridge] HTTP ${res.status} از ${url}. تلاش مجدد در ${delay}ms (${attempt}/${maxRetries})`);
        await wait(delay);
        continue;
      }
      return res;
    } catch (e) {
      // A user-initiated stop must win immediately — retrying an aborted
      // request would keep a "stopped" job burning model calls in the
      // background for several more seconds.
      if (e.name === 'AbortError') throw e;
      attempt++;
      if (attempt >= maxRetries) throw e;
      console.error(`[ai-bridge] خطای شبکه: ${e.message}. تلاش مجدد در ${attempt * 2500}ms`);
      await wait(attempt * 2500);
    }
  }
}

async function callGemini({ system, user, maxTokens, signal }) {
  const key = secret('GEMINI_API_KEY');
  if (!key) return { error: 'GEMINI_API_KEY تنظیم نشده — آن را در secrets.env قرار بده.' };
  const model = secret('GEMINI_MODEL') || 'gemini-2.0-flash';
  const body = { contents: [{ parts: [{ text: user }] }], generationConfig: { maxOutputTokens: maxTokens || defaultMaxTokens('gemini') } };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const res = await fetchWithRetry(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
    signal,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errStr = (j && j.error && j.error.message) || '';
    return { error: `Gemini ${res.status}: ${errStr}` };
  }
  const text = (j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0].text) || '';
  const usage = (j && j.usageMetadata) || {};
  return {
    text,
    usage: { promptTokens: usage.promptTokenCount || 0, completionTokens: usage.candidatesTokenCount || 0 },
  };
}

// Catalog of OpenAI-compatible engines, each with its own secrets.env keys so
// switching the toolbar's active engine never clobbers another engine's
// base URL / key / model (ported from business-generator-light's per-engine
// MODELS catalog in agent_bridge.js).
// 'openai-compatible' is kept as the internal id (so an existing secrets.env's
// AI_PROVIDER=openai-compatible / AI_API_KEY / AI_BASE_URL / AI_MODEL keep
// working untouched) — only its display label changes to GapGPT, since that's
// the endpoint this project's default (AI_BASE_URL's default value) actually
// points at, matching business-generator-light's engine naming.
const HTTP_ENGINES = {
  'openai-compatible': { id: 'openai-compatible', label: 'GapGPT', keyEnv: 'AI_API_KEY', baseEnv: 'AI_BASE_URL', baseDefault: 'https://api.gapgpt.app/v1', modelEnv: 'AI_MODEL', modelDefault: 'gpt-4o-mini' },
  '9router': { id: '9router', label: '9Router', keyEnv: 'NINEROUTER_API_KEY', baseEnv: 'NINEROUTER_BASE_URL', baseDefault: 'http://localhost:20128/v1', modelEnv: 'NINEROUTER_MODEL', modelDefault: 'combo' },
};

async function callHttpEngine(entry, { system, user, maxTokens, signal }) {
  const key = secret(entry.keyEnv);
  const base = (secret(entry.baseEnv) || entry.baseDefault).replace(/\/$/, '');
  const model = secret(entry.modelEnv) || entry.modelDefault;
  if (!key) return { error: `${entry.keyEnv} تنظیم نشده — آن را در secrets.env قرار بده.` };
  const messages = system ? [{ role: 'system', content: system }, { role: 'user', content: user }] : [{ role: 'user', content: user }];
  const res = await fetchWithRetry(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ model, max_tokens: maxTokens || defaultMaxTokens(entry.id), messages }),
    signal,
  });
  const rawText = await res.text();
  let j = {};
  try { j = JSON.parse(rawText); } catch (e) { j = { error: { message: rawText.slice(0, 500) } }; }
  if (!res.ok) {
    const errStr = (j && j.error && j.error.message) || '';
    return { error: `${model} ${res.status}: ${errStr}` };
  }
  const text = (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  const usage = (j && j.usage) || {};
  return {
    text,
    usage: { promptTokens: usage.prompt_tokens || 0, completionTokens: usage.completion_tokens || 0 },
  };
}

// ---- Claude CLI engine ------------------------------------------------
// Windows installs the `claude` CLI as a `.cmd` shim, and Node 18.20+/20.12+
// refuses to spawn a .cmd without a shell — it fails ENOENT even though the
// CLI is on PATH. Resolve it ourselves and route through cmd.exe only when
// it's actually a shim, so argument quoting stays Node's normal per-argument
// behavior (shell:true would break any arg containing spaces).
const isWin = process.platform === 'win32';
const binPathCache = new Map();
function resolveBinPath(bin) {
  if (!isWin) return bin;
  if (binPathCache.has(bin)) return binPathCache.get(bin);
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  let found = bin;
  outer: for (const dir of dirs) {
    for (const ext of exts) {
      const cand = path.join(dir, bin + ext.toLowerCase());
      if (fs.existsSync(cand)) { found = cand; break outer; }
    }
  }
  binPathCache.set(bin, found);
  return found;
}
function spawnClaude(args) {
  const resolved = resolveBinPath('claude');
  const opts = { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true };
  if (isWin && /\.(cmd|bat)$/i.test(resolved)) {
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', resolved, ...args], opts);
  }
  return spawn(resolved, args, opts);
}

// The CLI has no separate system/user turn for a one-shot `-p` call — the
// role text is prefixed onto the same prompt instead of being flattened away
// silently, so the model still sees "these are your instructions" framing.
// maxTokens is accepted and ignored on purpose: `claude -p` has no
// output-length flag — the CLI/subscription decides. Callers still pass one
// (the same call site feeds every engine), so silently accepting it beats
// making every caller special-case this engine.
async function callClaudeCli({ system, user, maxTokens, signal }) {
  const prompt = system ? `${system}\n\n---\n\n${user}` : user;
  const model = secret('CLAUDE_MODEL');
  const args = ['-p', '--output-format', 'json'];
  if (model) args.push('--model', model);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnClaude(args);
    } catch (e) {
      return resolve({ error: `اجرای claude CLI ممکن نشد: ${e.message}` });
    }
    let out = '', err = '';
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      child.kill();
      const e = new Error('aborted');
      e.name = 'AbortError';
      resolve(Promise.reject(e));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      resolve({ error: `claude CLI اجرا نشد: ${e.message} — مطمئن شو با "npm install -g @anthropic-ai/claude-code" نصب و "claude login" زده شده.` });
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      try {
        const r = JSON.parse(out);
        if (r.is_error || r.error) return resolve({ error: r.result || r.error || r.subtype || 'خطای نامشخص claude CLI' });
        // The CLI reports what the call actually cost — reading it means the
        // report's token counts are real for this engine too, instead of the
        // zeros that used to be hardcoded here (which made a claude-cli
        // review look free next to an HTTP one).
        const u = r.usage || {};
        return resolve({
          text: r.result || r.text || r.response || out,
          usage: {
            promptTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
            completionTokens: u.output_tokens || 0,
          },
        });
      } catch (e) {
        return resolve(out ? { text: out, usage: { promptTokens: 0, completionTokens: 0 } } : { error: 'خروجی خالی از claude CLI: ' + (err || '(بدون پیام خطا)') });
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// Shared by callModel (uses whatever AI_PROVIDER is active) and testEngine
// (uses a specific id regardless of which one is active) — one dispatch
// table so the two can't drift into picking different engines for the same id.
function dispatch(provider, opts) {
  if (provider === 'gemini') return callGemini(opts);
  if (provider === 'claude-cli') return callClaudeCli(opts);
  return callHttpEngine(HTTP_ENGINES[provider] || HTTP_ENGINES['openai-compatible'], opts);
}

async function callModel(opts) {
  if (opts.signal && opts.signal.aborted) {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  }
  // opts.provider overrides the configured engine — used when a review falls
  // back to a second engine because the first one is out of quota, without
  // rewriting AI_PROVIDER (which is the user's own choice, not ours to change).
  const provider = (opts.provider || secret('AI_PROVIDER') || 'openai-compatible').toLowerCase();

  // Detect an over-long prompt here rather than letting the endpoint answer
  // with an opaque HTTP 400 (or, worse, letting a provider silently drop the
  // middle of the prompt and review code the model never saw). The caller
  // gets the same { error } shape as any other engine failure, so a batch
  // that doesn't fit is reported as an unreviewed batch instead of vanishing.
  const check = require('./contextBudget').checkPrompt({ system: opts.system, user: opts.user, provider });
  if (check.overflow) {
    return {
      error: `حجم این درخواست از سقف context موتور ${check.provider} بیشتر است (حدود ${check.tokens} توکن در برابر سقف ${check.limit} توکن) — این بخش به مدل داده نشد.`,
      overflow: true,
      estimatedPromptTokens: check.tokens,
      promptTokenLimit: check.limit,
    };
  }

  const result = await dispatch(provider, opts);
  // Engines that report no usage of their own (or that only estimate) still
  // owe the report a number, so an over-budget prompt can be spotted after
  // the fact — kept in its own field, never mixed into billed usage.
  if (result && !result.error) result.estimatedPromptTokens = check.tokens;
  return result;
}

// The next engine that could actually run a review right now, skipping the
// one that just failed. "Ready" means its key is on file (or, for claude-cli,
// that the binary exists) — see engineStatus. Ordered by the ENGINES catalog,
// so the fallback is predictable rather than whichever happens to be first in
// an object's key order.
function listReadyEngines(excludeId) {
  return ENGINES
    .filter((e) => e.id !== excludeId && engineStatus(e.id).state === 'ready')
    .map((e) => e.id);
}

function pickFallbackEngine(excludeId) {
  return listReadyEngines(excludeId)[0] || null;
}

// Quota/limit answers are the reason a review should hop to another engine
// rather than give up: the engine works, it just refuses right now. A wrong
// key or a missing binary is not worth retrying elsewhere any differently —
// but it's still an engine-level failure, so both are treated the same by
// callers; this only exists to word the report honestly.
function isQuotaError(message) {
  // Persian patterns matter as much as the English ones: callHttpEngine and
  // callGemini phrase their own 429 handling in Persian, with Persian digits
  // (۴۲۹) — matching only /429/ would miss the very messages this codebase
  // generates for the case this function exists to detect.
  return /session limit|rate.?limit|quota|\b429\b|usage limit|سهمیه|۴۲۹|محدودیت مصرف|سقف/i.test(String(message || ''));
}

// Lists models an OpenAI-compatible endpoint actually serves (GET /models),
// used by the dashboard's model dropdown instead of a free-text field that's
// easy to typo. Not meaningful for gemini (no discovery endpoint used here)
// or claude-cli (the CLI/subscription decides what's available).
async function listModels() {
  const provider = (secret('AI_PROVIDER') || 'openai-compatible').toLowerCase();
  const entry = HTTP_ENGINES[provider];
  if (!entry) return { models: [], note: 'فهرست مدل فقط برای موتورهای openai-compatible (از جمله 9Router) در دسترس است.' };
  const key = secret(entry.keyEnv);
  const base = (secret(entry.baseEnv) || entry.baseDefault).replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = 'Bearer ' + key;
  const res = await fetchWithRetry(base + '/models', { headers }, 2);
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const ids = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
  return { models: ids };
}

// Engine catalog for the dashboard's toolbar model picker — one entry per
// selectable AI_PROVIDER value, with enough metadata to show a label/icon and
// tell whether it's ready to use without opening the settings modal.
const ENGINES = [
  { id: 'claude-cli', label: 'Claude', icon: '✳️', hint: 'اشتراک/لاگین claude CLI — بدون API key' },
  { id: 'openai-compatible', label: 'GapGPT', icon: '🌀', hint: 'یا هر اندپوینت دیگر سازگار با OpenAI' },
  { id: '9router', label: '9Router', icon: '🔀', hint: 'روتر چندمدله (پیش‌فرض: http://localhost:20128/v1)' },
  { id: 'gemini', label: 'Gemini', icon: '✨', hint: 'Google Generative Language API' },
];

// Is `bin` actually on PATH? (Windows needs the PATHEXT dance; POSIX doesn't.)
function cliInstalled(bin) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = isWin ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      if (fs.existsSync(path.join(dir, bin + ext.toLowerCase()))) return true;
    }
  }
  return false;
}

// state: 'ready' (a key is on file) | 'missing-key' | 'not-installed' |
// 'unverified'. claude-cli deliberately never reports 'ready': whether
// `claude login` has happened can't be known without spending a real call,
// and on macOS the credential lives in the Keychain rather than a file — so
// the honest answer is "installed, login unchecked" instead of a green tick
// this module hasn't earned.
function engineStatus(id) {
  const entry = HTTP_ENGINES[id];
  if (entry) return { state: secret(entry.keyEnv) ? 'ready' : 'missing-key', model: secret(entry.modelEnv) || entry.modelDefault };
  if (id === 'gemini') return { state: secret('GEMINI_API_KEY') ? 'ready' : 'missing-key', model: secret('GEMINI_MODEL') || 'gemini-2.0-flash' };
  if (id === 'claude-cli') return { state: cliInstalled('claude') ? 'unverified' : 'not-installed', model: secret('CLAUDE_MODEL') || '' };
  return { state: 'missing-key', model: '' };
}

function listEngines() {
  const active = (secret('AI_PROVIDER') || 'openai-compatible').toLowerCase();
  return ENGINES.map((e) => ({ ...e, ...engineStatus(e.id), active: e.id === active }));
}

// Fires one small real call at a specific engine, regardless of which one is
// currently active — this is what the dashboard's "تست اتصال" button uses,
// so "is this engine reachable" can be answered without switching to it and
// spending a full review on it. Timed, so a slow-but-working engine (a flaky
// local proxy, say) is visibly distinguishable from an instant failure.
async function testEngine(id) {
  const started = Date.now();
  try {
    const result = await dispatch(id, {
      system: '',
      user: 'این یک پیام تستی است. فقط با کلمه‌ی pong جواب بده، بدون هیچ توضیح دیگر.',
      maxTokens: 20,
    });
    const ms = Date.now() - started;
    if (result.error) return { ok: false, error: result.error, ms };
    return { ok: true, text: String(result.text || '').trim().slice(0, 200), ms };
  } catch (e) {
    return { ok: false, error: e.message, ms: Date.now() - started };
  }
}

module.exports = { callModel, listModels, listEngines, engineStatus, testEngine, pickFallbackEngine, listReadyEngines, isQuotaError, secret, budgetFor, defaultMaxTokens, HTTP_ENGINES, ENGINES };
