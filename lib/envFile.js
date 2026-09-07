// Read/write secrets.env from the dashboard's settings toolbar, instead of
// asking the user to hand-edit the file. Two things this has to get right:
//
// 1. Never show a real secret back to the browser — GET returns a masked
//    value (last 4 characters only); the frontend re-sends a key only when
//    the user actually typed something new into it.
// 2. Never clobber lines the schema doesn't know about — this file preserves
//    every existing line and only rewrites the ones being updated, appending
//    genuinely new keys at the end instead of regenerating the whole file.
const fs = require('fs');
const path = require('path');
const { secret } = require('./ai_bridge');

const SECRETS_PATH = path.join(__dirname, '..', 'secrets.env');

// One entry per key the dashboard exposes. `group` drives the section
// headings in the settings modal and `hint` is shown under the field.
// `engine` ties a key to one AI engine, so the settings modal can fold each
// engine's own config into its own collapsible section (and open only the
// active one) instead of showing all four engines' fields flat — with one
// engine active, the other nine fields are noise.
const SCHEMA = [
  { key: 'PROJECT_PATH', group: 'پروژه‌ی محلی', secret: false, required: true,
    hint: 'مسیر کامل پوشه‌ی پروژه روی همین سیستم که از قبل با git clone گرفته شده — لازم است تا ریویو به‌جای دیف بریده‌شده‌ی گیت‌لب، فایل کامل را ببیند و گزارش را در پوشه‌ی review/ همان پروژه بنویسد.' },
  { key: 'GITLAB_URL', group: 'گیت‌لب', secret: false, hint: 'مثلاً https://gitlab.com یا آدرس نسخه‌ی self-hosted شما' },
  { key: 'GITLAB_TOKEN', group: 'گیت‌لب', secret: true, hint: 'Access Token با اسکوپ api' },
  { key: 'GITLAB_PROJECT_ID', group: 'گیت‌لب', secret: false, hint: 'اختیاری — خالی یعنی همه‌ی MRهایی که توکن دسترسی دارد' },
  { key: 'WEBHOOK_SECRET', group: 'گیت‌لب', secret: true, hint: 'فقط لازم اگر از Webhook (نه حالت خودکار polling) استفاده می‌کنی' },
  // Writable (the toolbar's engine picker writes it through writeValues) but
  // never rendered as a form field: the toolbar owns that choice, and a second
  // control for it here would be two places to change one thing.
  { key: 'AI_PROVIDER', group: 'هوش مصنوعی', secret: false, internal: true },
  { key: 'CLAUDE_MODEL', group: 'Claude', engine: 'claude-cli', secret: false, hint: 'خالی = مدل پیش‌فرض CLI. احراز هویت با `claude login` انجام می‌شود، نه کلید API.' },
  { key: 'AI_API_KEY', group: 'GapGPT', engine: 'openai-compatible', secret: true },
  { key: 'AI_BASE_URL', group: 'GapGPT', engine: 'openai-compatible', secret: false, hint: 'خالی = https://api.gapgpt.app/v1' },
  { key: 'AI_MODEL', group: 'GapGPT', engine: 'openai-compatible', secret: false, hint: 'خالی = gpt-4o-mini' },
  { key: 'NINEROUTER_API_KEY', group: '9Router', engine: '9router', secret: true },
  { key: 'NINEROUTER_BASE_URL', group: '9Router', engine: '9router', secret: false, hint: 'خالی = http://localhost:20128/v1' },
  { key: 'NINEROUTER_MODEL', group: '9Router', engine: '9router', secret: false, hint: 'خالی = combo' },
  { key: 'GEMINI_API_KEY', group: 'Gemini', engine: 'gemini', secret: true },
  { key: 'GEMINI_MODEL', group: 'Gemini', engine: 'gemini', secret: false, hint: 'خالی = gemini-2.0-flash' },
  { key: 'ADMIN_TOKEN', group: 'دسترسی', secret: true, hint: 'خالی = فقط از همین دستگاه (localhost) بدون توکن قابل استفاده' },
  // Groundwork only — lib/jira.js reads these but nothing in the product
  // calls it yet. Filled in ahead of building the actual Jira report
  // integration, so the fields exist and are testable before the feature
  // itself lands.
  { key: 'JIRA_BASE_URL', group: 'جیرا (به‌زودی)', secret: false, hint: 'مثلاً https://yourteam.atlassian.net — هنوز در گزارش‌ها استفاده نمی‌شود' },
  { key: 'JIRA_EMAIL', group: 'جیرا (به‌زودی)', secret: false, hint: 'ایمیل حساب جیرا (برای Basic Auth با API token)' },
  { key: 'JIRA_API_TOKEN', group: 'جیرا (به‌زودی)', secret: true, hint: 'از id.atlassian.com/manage-profile/security/api-tokens' },
  { key: 'JIRA_PROJECT_KEY', group: 'جیرا (به‌زودی)', secret: false, hint: 'مثلاً EM — همان پیشوندی که از نام برنچ/تسک استخراج می‌شود' },
];

function mask(value) {
  const v = String(value || '');
  if (!v) return '';
  if (v.length <= 4) return '••••';
  return '•'.repeat(Math.max(v.length - 4, 4)) + v.slice(-4);
}

// What the settings modal renders: current value (masked for secrets) plus
// enough metadata to group and label the fields.
function describe() {
  return SCHEMA.map((entry) => {
    const raw = secret(entry.key);
    return {
      key: entry.key,
      group: entry.group,
      engine: entry.engine || null,
      internal: !!entry.internal,
      secret: !!entry.secret,
      required: !!entry.required,
      hint: entry.hint || '',
      value: entry.secret ? mask(raw) : raw,
      set: !!raw,
    };
  });
}

function readRawLines() {
  try {
    return fs.readFileSync(SECRETS_PATH, 'utf8').split('\n');
  } catch (e) {
    return [];
  }
}

// Applies `updates` (key -> new value) onto secrets.env, keeping every other
// line — comments, ordering, blank lines — exactly as it was. A key with no
// existing `KEY=` line is appended at the end.
function writeValues(updates) {
  const known = new Set(SCHEMA.map((e) => e.key));
  const keysToWrite = Object.keys(updates).filter((k) => known.has(k));
  if (!keysToWrite.length) return { written: [] };

  const lines = readRawLines();
  const remaining = new Set(keysToWrite);

  const next = lines.map((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    const i = t.indexOf('=');
    if (i < 0) return line;
    const key = t.slice(0, i).trim();
    if (!remaining.has(key)) return line;
    remaining.delete(key);
    return `${key}=${updates[key]}`;
  });

  if (remaining.size) {
    if (next.length && next[next.length - 1].trim() !== '') next.push('');
    for (const key of remaining) next.push(`${key}=${updates[key]}`);
  }

  fs.writeFileSync(SECRETS_PATH, next.join('\n'));
  return { written: keysToWrite };
}

module.exports = { SCHEMA, describe, writeValues, mask };
