// Two judgements about a Sentry crash that the raw event cannot give you:
// what it means in plain Persian, and who has room to take it.
//
// Both are advisory. The explanation is a model reading a stack trace, and
// the suggestion is arithmetic over current workload — neither knows the
// thing a lead knows about who is already deep in that part of the codebase.
// They are here to save the reading, not to make the decision.
const { callModel } = require('./ai_bridge');
const cache = require('./cache');

// Keyed by Sentry issue id. The explanation costs a model call and the crash
// does not change between two people opening the same issue in one morning,
// so it is worth not paying for twice.
const ANALYSIS_CACHE = 'sentry-analysis-v1';
const ANALYSIS_TTL_MS = 24 * 60 * 60 * 1000;

// How much stack reaches the model. Enough to see the failing call path;
// not so much that a 300-frame Android trace crowds out the question.
const MAX_FRAMES = 25;

// In-app frames first — they are where a fix lands, and framework frames
// below them are mostly noise for this purpose.
function renderStack(exceptions) {
  const lines = [];
  for (const ex of exceptions || []) {
    lines.push(`${ex.type || 'Exception'}: ${ex.value || ''}`);
    const frames = (ex.frames || []).slice().reverse(); // Sentry stores innermost last
    const ordered = [...frames.filter((f) => f.inApp), ...frames.filter((f) => !f.inApp)];
    for (const f of ordered.slice(0, MAX_FRAMES)) {
      lines.push(`  ${f.inApp ? '>' : ' '} ${f.filename || '?'}:${f.lineNo == null ? '?' : f.lineNo} — ${f.function || '?'}`);
    }
    if (ordered.length > MAX_FRAMES) lines.push(`  … و ${ordered.length - MAX_FRAMES} فریم دیگر`);
  }
  return lines.join('\n');
}

function buildPrompt(issue) {
  return [
    'این یک خطای ثبت‌شده در Sentry است. برای یک توسعه‌دهنده‌ی فارسی‌زبان توضیحش بده.',
    '',
    `عنوان: ${issue.title}`,
    issue.value ? `پیام: ${issue.value}` : '',
    issue.culprit ? `محل: ${issue.culprit}` : '',
    `سطح: ${issue.level || '—'} · ${issue.count} رخداد · ${issue.userCount} کاربر متأثر`,
    issue.release ? `نسخه: ${issue.release}` : '',
    issue.environment ? `محیط: ${issue.environment}` : '',
    '',
    'استک‌تریس (خطوط با > کد خودِ پروژه است، بقیه فریم‌ورک):',
    '```',
    renderStack(issue.exceptions) || '(استک‌تریسی ثبت نشده)',
    '```',
    '',
    'خروجی را فقط به‌صورت یک JSON معتبر بده، بدون ``` و بدون هیچ متن قبل و بعدش:',
    '{',
    '  "summary": "در یک تا دو جمله‌ی فارسی: این خطا یعنی چه و کاربر چه چیزی می‌بیند",',
    '  "cause": "محتمل‌ترین علت، بر اساس همین استک‌تریس. اگر مطمئن نیستی صریح بگو که حدس است.",',
    '  "where": "دقیقاً کدام فایل/تابع باید اول نگاه شود — از روی فریم‌های کد خودِ پروژه",',
    '  "fix": "پیشنهاد مشخص برای رفع، یا اگر از این اطلاعات قابل تشخیص نیست بگو چه چیز دیگری لازم است",',
    '  "userImpact": "low" | "medium" | "high"',
    '}',
    '',
    'نام فایل، تابع، کلاس و متن خطا را انگلیسی و دقیقاً به همان شکل اصلی بگذار — ترجمه‌شان باعث می‌شود در کد پیدا نشوند.',
    'چیزی را که از این استک‌تریس قابل نتیجه‌گیری نیست، حدس نزن و به‌عنوان قطعیت ننویس.',
  ].filter(Boolean).join('\n');
}

function parseJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '');
  try { return JSON.parse(raw); } catch (e) { /* fall through */ }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch (e) { /* give up */ }
  }
  return null;
}

// Never throws: an explanation that could not be produced is a missing
// nicety, and failing the whole issue-detail request over it would hide the
// stack trace the reader came for.
async function explain(issue, { force = false } = {}) {
  try {
    const { value, at, fromCache } = await cache.cached(
      ANALYSIS_CACHE, String(issue.id), ANALYSIS_TTL_MS,
      async () => {
        const res = await callModel({
          system: 'تو یک مهندس ارشد هستی که خطاهای production را برای تیم توضیح می‌دهد. کوتاه، دقیق، بدون حاشیه.',
          user: buildPrompt(issue),
          maxTokens: 900,
        });
        const parsed = parseJson(res && res.text);
        if (!parsed) throw new Error('پاسخ مدل JSON معتبر نبود');
        return parsed;
      },
      { force }
    );
    return { ...value, at, fromCache };
  } catch (e) {
    return { error: e.message };
  }
}

// ---- who should take it ----------------------------------------------------

// Sentry severity -> Jira priority. Kept as a table rather than derived so
// the mapping is arguable in one place; `warning` lands on Medium rather
// than Low because a warning Sentry kept and grouped is already past the
// threshold where anyone bothered to report it.
const PRIORITY_BY_LEVEL = {
  fatal: 'Highest',
  error: 'High',
  warning: 'Medium',
  info: 'Low',
  debug: 'Low',
};

function priorityFor(issue) {
  const base = PRIORITY_BY_LEVEL[String(issue && issue.level || '').toLowerCase()] || 'Medium';
  // Reach escalates one step: an error hitting hundreds of users is not the
  // same ticket as the same error hitting two, and the level cannot say so.
  if ((Number(issue && issue.userCount) || 0) >= 50) {
    if (base === 'High') return 'Highest';
    if (base === 'Medium') return 'High';
    if (base === 'Low') return 'Medium';
  }
  return base;
}

// Load score per developer, from the numbers the team view already computes
// (lib/teamOverview.js). Lower is freer.
//
// Deliberately counts what is *in flight*, not what was delivered: open
// merge requests, tasks in progress, and things already flagged as needing
// attention. A strong engineer who shipped a lot last month is not therefore
// the right person to hand another crash to today.
//
// The weights say what "busy" means here: an in-progress task is the unit of
// committed work, an open MR is nearly-done work that still needs finishing,
// and an attention item is something already going wrong for them.
function loadScore(row) {
  // inProgressCount, not inProgress — that is teamOverview.buildRow's own
  // field name, and reading the wrong one scores every developer as free.
  const inProgress = Number(row.inProgressCount) || 0;
  const openMrs = Number(row.openMrs) || 0;
  const attention = Number(row.attention) || 0;
  return inProgress * 2 + openMrs * 1.5 + attention;
}

// Ranked suggestion, freest first. Returns the reasoning alongside each
// name, because "assign to X" without the numbers behind it is a decision
// nobody can check.
function suggestAssignees(teamRows, { limit = 3 } = {}) {
  const usable = (teamRows || []).filter((r) => r && r.username && !r.pending && !r.error);
  if (!usable.length) return [];
  return usable
    .map((r) => ({
      username: r.username,
      name: r.name || r.username,
      load: Math.round(loadScore(r) * 10) / 10,
      inProgress: Number(r.inProgressCount) || 0,
      openMrs: Number(r.openMrs) || 0,
      attention: Number(r.attention) || 0,
    }))
    .sort((a, b) => a.load - b.load)
    .slice(0, limit);
}

module.exports = {
  explain, suggestAssignees, priorityFor, loadScore,
  buildPrompt, renderStack, parseJson,
  PRIORITY_BY_LEVEL, ANALYSIS_CACHE,
};
