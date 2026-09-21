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
const { atomicWriteFileSync } = require('./atomicWrite');

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
  { key: 'CLAUDE_MODEL', group: 'Claude', engine: 'claude-cli', secret: false, hint: 'خالی = مدل پیش‌فرض CLI. نام کوتاه (sonnet / opus / haiku) همیشه آخرین نسخه‌ی همان خانواده را می‌گیرد؛ نام کامل (claude-sonnet-5) نسخه را قفل می‌کند. احراز هویت با `claude login` انجام می‌شود، نه کلید API.' },
  // Rendered as a slider. The levels are ordered weakest-to-strongest and the
  // empty first position means "omit --effort", which is not the same as
  // 'low' — it hands the choice back to the CLI's own default.
  { key: 'CLAUDE_EFFORT', group: 'Claude', engine: 'claude-cli', secret: false,
    control: 'slider', levels: ['', 'low', 'medium', 'high', 'xhigh', 'max'],
    hint: 'سطح تلاش مدل، از چپ به راست کم به زیاد. بالاتر یعنی دقیق‌تر ولی کندتر و پرهزینه‌تر. اولین حالت («پیش‌فرض») یعنی فلگ اصلاً پاس داده نشود و خود CLI تصمیم بگیرد.' },
  { key: 'AI_API_KEY', group: 'GapGPT', engine: 'openai-compatible', secret: true },
  { key: 'AI_BASE_URL', group: 'GapGPT', engine: 'openai-compatible', secret: false, hint: 'خالی = https://api.gapgpt.app/v1' },
  { key: 'AI_MODEL', group: 'GapGPT', engine: 'openai-compatible', secret: false, hint: 'خالی = gpt-4o-mini' },
  { key: 'NINEROUTER_API_KEY', group: '9Router', engine: '9router', secret: true },
  { key: 'NINEROUTER_BASE_URL', group: '9Router', engine: '9router', secret: false, hint: 'خالی = http://localhost:20128/v1' },
  { key: 'NINEROUTER_MODEL', group: '9Router', engine: '9router', secret: false, hint: 'خالی = combo' },
  { key: 'GEMINI_API_KEY', group: 'Gemini', engine: 'gemini', secret: true },
  { key: 'GEMINI_MODEL', group: 'Gemini', engine: 'gemini', secret: false, hint: 'خالی = gemini-2.0-flash' },
  // Context budget overrides (lib/contextBudget.js). Empty is the normal
  // case: each engine's real window is already in the catalog there. These
  // exist for the two situations the catalog can't know about — a 9Router
  // "combo" that actually fronts a big-window model, or a model that answers
  // 400 on prompts the catalog thinks fit. Per-engine keys
  // (CLAUDE_CONTEXT_TOKENS, AI_CONTEXT_TOKENS, NINEROUTER_CONTEXT_TOKENS,
  // GEMINI_CONTEXT_TOKENS and their *_MAX_OUTPUT_TOKENS twins) work too and
  // win over these, but are deliberately not fields here — four engines ×
  // two numbers is a settings panel nobody can read.
  { key: 'REVIEW_CONTEXT_TOKENS', group: 'هوش مصنوعی', secret: false,
    hint: 'اختیاری — خالی یعنی پنجره‌ی واقعی همان موتور (Claude ۲۰۰هزار، GapGPT ۱۲۸هزار، 9Router ۳۲هزار، Gemini ۱میلیون توکن)' },
  { key: 'REVIEW_MAX_OUTPUT_TOKENS', group: 'هوش مصنوعی', secret: false,
    hint: 'اختیاری — سقف طول پاسخ مدل در هر فراخوانی. خالی = پیش‌فرض همان موتور' },
  { key: 'ADMIN_TOKEN', group: 'دسترسی', secret: true, hint: 'خالی = فقط از همین دستگاه (localhost) بدون توکن قابل استفاده' },
  // Which weekdays this org actually works, in Persian day names — read by
  // lib/workCalendar.js. Nothing here scores anything yet; this is the
  // input the "تأخیر بر اساس روز کاری" adjustment (still being designed)
  // will read once it lands. Empty means "assume every day" — the flat
  // calendar-day count every date calculation in this project has always
  // used, so a site that never fills this in is unaffected.
  { key: 'WORKING_DAYS', group: 'تقویم کاری', secret: false,
    hint: 'روزهای کاری هفته، با کاما جدا — مثلاً شنبه,یکشنبه,دوشنبه,سه‌شنبه,چهارشنبه (پیش‌فرض تعطیلات ایران: پنجشنبه و جمعه تعطیل). خالی یعنی همه‌ی روزها کاری حساب شوند، مثل الان.' },
  // Powers the Developer Analytics task cards' Jira status/assignee badge
  // (lib/jira.js). Self-hosted Jira (this org's jira.tamin.ir), so auth is
  // a Personal Access Token (Bearer), not Cloud's email+API-token Basic
  // Auth — JIRA_EMAIL is intentionally not a field here. JIRA_PROJECT_KEY
  // isn't read anywhere yet — task keys are matched by the full key
  // extracted from the branch/title (task.js), not by project prefix —
  // kept here for the next Jira feature to use.
  { key: 'JIRA_BASE_URL', group: 'جیرا', secret: false, hint: 'مثلاً https://jira.tamin.ir (بدون / در انتها)' },
  { key: 'JIRA_API_TOKEN', group: 'جیرا', secret: true, hint: 'Personal Access Token — از پروفایل خودت در جیرا بساز (راهنما را در پیام دستیار ببین)' },
  { key: 'JIRA_PROJECT_KEY', group: 'جیرا', secret: false, hint: 'مثلاً EM — پروژه‌ای که تسک‌های ساخته‌شده از Sentry در آن ثبت می‌شوند' },
  // Sentry (self-hosted, like this org's GitLab and Jira). Read-only: the
  // integration lists unresolved issues and turns one into a Jira task —
  // it never writes back to Sentry, so the token needs no write scope.
  { key: 'SENTRY_URL', group: 'سنتری', secret: false, hint: 'آدرس پایه‌ی Sentry خودتان، مثلاً https://sentry.tamin.ir (بدون / در انتها)' },
  { key: 'SENTRY_ORG', group: 'سنتری', secret: false, hint: 'slug سازمان — همان چیزی که در آدرس داشبورد Sentry بعد از /organizations/ می‌آید' },
  { key: 'SENTRY_PROJECT', group: 'سنتری', secret: false, hint: 'slug پروژه. چند پروژه را با کاما جدا کن، مثلاً mobile,backend' },
  { key: 'SENTRY_AUTH_TOKEN', group: 'سنتری', secret: true, hint: 'Auth Token با اسکوپ‌های org:read و project:read و event:read — از Settings → Account → API → Auth Tokens' },
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
      // A field can ask for a control other than a text box. `levels` is the
      // ordered list of values the slider can land on; the empty string is a
      // real position, meaning "don't pass the flag at all".
      control: entry.control || 'text',
      levels: entry.levels || null,
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

  atomicWriteFileSync(SECRETS_PATH, next.join('\n'));
  return { written: keysToWrite };
}

module.exports = { SCHEMA, describe, writeValues, mask };
