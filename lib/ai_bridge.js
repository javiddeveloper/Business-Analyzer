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
  const model = secret('AI_MODEL') || 'gemini-2.0-flash';
  const body = { contents: [{ parts: [{ text: user }] }], generationConfig: { maxOutputTokens: maxTokens || 4000 } };
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

async function callOpenAICompatible({ system, user, maxTokens, signal }) {
  const key = secret('AI_API_KEY');
  const base = (secret('AI_BASE_URL') || 'https://api.gapgpt.app/v1').replace(/\/$/, '');
  const model = secret('AI_MODEL') || 'gpt-4o-mini';
  if (!key) return { error: 'AI_API_KEY تنظیم نشده — آن را در secrets.env قرار بده.' };
  const messages = system ? [{ role: 'system', content: system }, { role: 'user', content: user }] : [{ role: 'user', content: user }];
  const res = await fetchWithRetry(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ model, max_tokens: maxTokens || 4000, messages }),
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
async function callClaudeCli({ system, user, maxTokens, signal }) {
  const prompt = system ? `${system}\n\n---\n\n${user}` : user;
  const model = secret('AI_MODEL');
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
        return resolve({ text: r.result || r.text || r.response || out, usage: { promptTokens: 0, completionTokens: 0 } });
      } catch (e) {
        return resolve(out ? { text: out, usage: { promptTokens: 0, completionTokens: 0 } } : { error: 'خروجی خالی از claude CLI: ' + (err || '(بدون پیام خطا)') });
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function callModel(opts) {
  if (opts.signal && opts.signal.aborted) {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  }
  const provider = (secret('AI_PROVIDER') || 'openai-compatible').toLowerCase();
  if (provider === 'gemini') return callGemini(opts);
  if (provider === 'claude-cli') return callClaudeCli(opts);
  return callOpenAICompatible(opts);
}

// Lists models an OpenAI-compatible endpoint actually serves (GET /models),
// used by the dashboard's model dropdown instead of a free-text field that's
// easy to typo. Not meaningful for gemini (no discovery endpoint used here)
// or claude-cli (the CLI/subscription decides what's available).
async function listModels() {
  const provider = (secret('AI_PROVIDER') || 'openai-compatible').toLowerCase();
  if (provider !== 'openai-compatible') return { models: [], note: 'فهرست مدل فقط برای openai-compatible در دسترس است.' };
  const key = secret('AI_API_KEY');
  const base = (secret('AI_BASE_URL') || 'https://api.gapgpt.app/v1').replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = 'Bearer ' + key;
  const res = await fetchWithRetry(base + '/models', { headers }, 2);
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const ids = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
  return { models: ids };
}

module.exports = { callModel, listModels, secret };
