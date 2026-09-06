// Minimal, dependency-free AI bridge — adapted from business-generator-light's
// agent_bridge.js (same secrets.env convention, same fetchWithRetry pattern),
// trimmed down to the two provider paths this product actually needs:
// an OpenAI-compatible chat/completions endpoint (GapGPT, OpenAI, Ollama, …)
// and Gemini's native API. No CLI-engine support, no model catalog — this
// product always reviews with whatever AI_PROVIDER/AI_MODEL is configured.
const fs = require('fs');
const path = require('path');

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
      attempt++;
      if (attempt >= maxRetries) throw e;
      console.error(`[ai-bridge] خطای شبکه: ${e.message}. تلاش مجدد در ${attempt * 2500}ms`);
      await wait(attempt * 2500);
    }
  }
}

async function callGemini({ system, user, maxTokens }) {
  const key = secret('GEMINI_API_KEY');
  if (!key) return { error: 'GEMINI_API_KEY تنظیم نشده — آن را در secrets.env قرار بده.' };
  const model = secret('AI_MODEL') || 'gemini-2.0-flash';
  const body = { contents: [{ parts: [{ text: user }] }], generationConfig: { maxOutputTokens: maxTokens || 4000 } };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const res = await fetchWithRetry(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errStr = (j && j.error && j.error.message) || '';
    return { error: `Gemini ${res.status}: ${errStr}` };
  }
  const text = (j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0].text) || '';
  return { text };
}

async function callOpenAICompatible({ system, user, maxTokens }) {
  const key = secret('AI_API_KEY');
  const base = (secret('AI_BASE_URL') || 'https://api.gapgpt.app/v1').replace(/\/$/, '');
  const model = secret('AI_MODEL') || 'gpt-4o-mini';
  if (!key) return { error: 'AI_API_KEY تنظیم نشده — آن را در secrets.env قرار بده.' };
  const messages = system ? [{ role: 'system', content: system }, { role: 'user', content: user }] : [{ role: 'user', content: user }];
  const res = await fetchWithRetry(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ model, max_tokens: maxTokens || 4000, messages }),
  });
  const rawText = await res.text();
  let j = {};
  try { j = JSON.parse(rawText); } catch (e) { j = { error: { message: rawText.slice(0, 500) } }; }
  if (!res.ok) {
    const errStr = (j && j.error && j.error.message) || '';
    return { error: `${model} ${res.status}: ${errStr}` };
  }
  const text = (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  return { text };
}

async function callModel(opts) {
  const provider = (secret('AI_PROVIDER') || 'openai-compatible').toLowerCase();
  if (provider === 'gemini') return callGemini(opts);
  return callOpenAICompatible(opts);
}

module.exports = { callModel, secret };
