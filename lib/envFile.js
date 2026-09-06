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
// headings in the settings modal; `hint` is shown under the field.
const SCHEMA = [
  { key: 'PROJECT_PATH', group: 'پروژه‌ی محلی', secret: false, required: true,
    hint: 'مسیر کامل پوشه‌ی پروژه روی همین سیستم که از قبل با git clone گرفته شده — لازم است تا ریویو به‌جای دیف بریده‌شده‌ی گیت‌لب، فایل کامل را ببیند و گزارش را در پوشه‌ی review/ همان پروژه بنویسد.' },
  { key: 'GITLAB_URL', group: 'گیت‌لب', secret: false, hint: 'مثلاً https://gitlab.com یا آدرس نسخه‌ی self-hosted شما' },
  { key: 'GITLAB_TOKEN', group: 'گیت‌لب', secret: true, hint: 'Access Token با اسکوپ api' },
  { key: 'GITLAB_PROJECT_ID', group: 'گیت‌لب', secret: false, hint: 'اختیاری — خالی یعنی همه‌ی MRهایی که توکن دسترسی دارد' },
  { key: 'WEBHOOK_SECRET', group: 'گیت‌لب', secret: true, hint: 'فقط لازم اگر از Webhook (نه حالت خودکار polling) استفاده می‌کنی' },
  { key: 'AI_PROVIDER', group: 'هوش مصنوعی', secret: false, hint: 'openai-compatible | gemini' },
  { key: 'AI_MODEL', group: 'هوش مصنوعی', secret: false },
  { key: 'AI_API_KEY', group: 'هوش مصنوعی', secret: true },
  { key: 'AI_BASE_URL', group: 'هوش مصنوعی', secret: false },
  { key: 'GEMINI_API_KEY', group: 'هوش مصنوعی', secret: true, hint: 'فقط وقتی AI_PROVIDER=gemini است' },
  { key: 'ADMIN_TOKEN', group: 'دسترسی', secret: true, hint: 'خالی = فقط از همین دستگاه (localhost) بدون توکن قابل استفاده' },
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
