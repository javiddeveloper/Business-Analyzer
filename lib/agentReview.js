// Whole-project review: instead of mailing the model a diff in batches, this
// runs the Claude Code CLI *inside a checkout of the MR* and lets it explore —
// read the files around the change, grep for callers, open the tests, compare
// against the previous implementation. That's what an IDE-integrated agent
// does, and it's the only way to catch the class of problem a diff can't show
// on its own ("this function has three other callers that now break").
//
// Why this path exists separately from reviewer.js's batch path: only the
// claude-cli engine has tools. An HTTP model (GapGPT/Gemini/9Router) can't
// read the repo, so for those the diff-batch path stays the right answer.
//
// Read-only by construction: `--permission-mode plan` plus an explicit
// read-only tool allowlist, run against a throwaway detached worktree. The
// agent cannot edit the project, and the user's own checkout is never touched.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const knowledge = require('./knowledge');
const diffLib = require('./diff');
const checks = require('./checks');

const ROLE_PATH = path.join(__dirname, '..', 'roles', 'tech-lead.md');

// The agent reads whatever it needs from disk, so the diff in the prompt is
// context/orientation, not the whole payload — it can be trimmed much harder
// than the batch path's budget without losing coverage.
const MAX_DIFF_CHARS = 60000;
// A whole-project agent run does real work (tool calls, multiple turns); this
// is the wall-clock ceiling before we give up and report it honestly.
const AGENT_TIMEOUT_MS = 15 * 60 * 1000;

const isWin = process.platform === 'win32';

function resolveClaudeBin() {
  if (!isWin) return 'claude';
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const cand = path.join(dir, 'claude' + ext.toLowerCase());
      if (fs.existsSync(cand)) return cand;
    }
  }
  return 'claude';
}

function loadRole() {
  try { return fs.readFileSync(ROLE_PATH, 'utf8'); } catch (e) { return ''; }
}

function buildPrompt({ mr, files, skipped, diffText }) {
  const fileList = files.map((f) => {
    const c = diffLib.countChanges(f.diff);
    return `- ${f.path} (+${c.added}/-${c.removed})${f.isNew ? ' [فایل جدید]' : ''}`;
  }).join('\n');

  return [
    loadRole(),
    knowledge.contextBlock(),
    '',
    '## این Merge Request',
    `عنوان: ${mr.title || ''}`,
    mr.description ? `توضیحات: ${String(mr.description).slice(0, 2000)}` : '',
    `شاخه: ${mr.source_branch || '?'} → ${mr.target_branch || '?'}`,
    '',
    '## فایل‌های تغییریافته',
    fileList || '(هیچ فایل قابل‌بررسی‌ای نبود)',
    skipped.length ? `\n(${skipped.length} فایل رد شد: ${skipped.map((s) => s.path).join('، ')})` : '',
    '',
    '## چطور کار کن',
    'تو داخل یک چک‌اوت کامل از همین پروژه، دقیقاً روی همان کامیتِ این MR، قرار داری. پوشه‌ی جاری ریشه‌ی پروژه است.',
    'فقط به دیف اکتفا نکن — **قبل از قضاوت، پروژه را بگرد**:',
    '- فایل کاملی که تغییر کرده را باز کن، نه فقط چند خط اطرافش.',
    '- برای هر تابع/کلاس/فیلدی که امضا یا رفتارش عوض شده، با Grep دنبال بقیه‌ی جاهایی بگرد که صدایش می‌زنند و چک کن نشکسته باشند.',
    '- تست‌های مربوطه را پیدا و بخوان: آیا این تغییر تست دارد؟ آیا تست موجود دیگر بی‌ربط/غلط شده؟',
    '- اگر الگوی مشابهی جای دیگری در همین کدبیس حل شده، مقایسه کن که این پیاده‌سازی با آن یکدست است یا نه.',
    '- اگر پوشه‌ی `old_android/` یا نسخه‌ی قبلی همین قابلیت وجود دارد، رفتار قدیمی را با جدید مقایسه کن (اعتبارسنجی‌ها، حالت‌های خطا، ترتیب عملیات).',
    '',
    'فقط چیزی را گزارش کن که واقعاً دیدی. اگر ادعایی می‌کنی، باید از فایلی که خواندی قابل‌ردیابی باشد. یافته‌ی الکی نساز تا دقیق به‌نظر برسی.',
    '',
    '## خروجی',
    'در پایان، **فقط و فقط** یک JSON معتبر چاپ کن — بدون ```، بدون هیچ متن قبل یا بعدش:',
    '{',
    '  "summary": "۲ تا ۵ جمله: این تغییر چه می‌کند و ریسک اصلی‌اش کجاست",',
    '  "findings": [',
    '    {',
    '      "file": "مسیر فایل از ریشه‌ی پروژه",',
    '      "line": 123,',
    '      "severity": "High" | "Medium" | "Low",',
    '      "category": "logic" | "security" | "performance" | "error-handling" | "tests" | "style" | "knowledge-base",',
    '      "title": "عنوان کوتاه",',
    '      "note": "چه اتفاقی می‌افتد و چرا مشکل است — با سناریوی مشخص شکست. اگر از فایل دیگری فهمیدی، همان‌جا اسمش را بیاور.",',
    '      "suggestion": "کد یا تغییر پیشنهادی (اختیاری)"',
    '    }',
    '  ],',
    '  "positives": ["اگر واقعاً چیز خوبی دیدی، کوتاه بگو؛ وگرنه آرایه‌ی خالی"]',
    '}',
    '',
    '## دیف (برای جهت‌گیری — منبع اصلی‌ات خود فایل‌هاست)',
    '```diff',
    diffText,
    '```',
  ].filter(Boolean).join('\n');
}

function buildDiffText(files) {
  let out = '';
  for (const f of files) {
    const chunk = `--- ${f.path}\n${f.diff}\n\n`;
    if (out.length + chunk.length > MAX_DIFF_CHARS) {
      out += `\n[... بقیه‌ی دیف اینجا نیامده — فایل‌ها را مستقیم از پروژه بخوان ...]\n`;
      break;
    }
    out += chunk;
  }
  return out || '(بدون دیف)';
}

function parseJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '');
  // The agent's final message may wrap the JSON in prose despite instructions;
  // take the last balanced-looking object, which is the one it ended on.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch (e) { return null; }
}

function runAgent({ cwd, prompt, model, signal }) {
  const args = [
    '-p', '--output-format', 'json',
    '--permission-mode', 'plan',
    '--allowedTools', 'Read Grep Glob',
  ];
  if (model) args.push('--model', model);

  return new Promise((resolve, reject) => {
    const bin = resolveClaudeBin();
    const opts = { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true };
    const child = isWin && /\.(cmd|bat)$/i.test(bin)
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', bin, ...args], opts)
      : spawn(bin, args, opts);

    let out = '', err = '', settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };

    const timer = setTimeout(() => {
      child.kill();
      finish(resolve, { error: `ایجنت بعد از ${AGENT_TIMEOUT_MS / 60000} دقیقه جواب نداد و متوقف شد.` });
    }, AGENT_TIMEOUT_MS);

    const onAbort = () => {
      child.kill();
      const e = new Error('aborted');
      e.name = 'AbortError';
      finish(reject, e);
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => finish(resolve, { error: `اجرای claude CLI ممکن نشد: ${e.message}` }));
    child.on('close', () => {
      try {
        const r = JSON.parse(out);
        if (r.is_error || r.error) return finish(resolve, { error: r.result || r.error || r.subtype || 'خطای نامشخص claude CLI' });
        return finish(resolve, { text: r.result || '', turns: r.num_turns, costUsd: r.total_cost_usd, usage: r.usage });
      } catch (e) {
        return finish(resolve, out
          ? { text: out }
          : { error: 'خروجی خالی از claude CLI: ' + (err || '(بدون پیام خطا)').slice(0, 300) });
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// Same return shape as reviewer.review(), so publish/report/dashboard code
// doesn't care which path produced a review.
async function review({ mr, changes, worktreePath, model, signal }) {
  const { files, skipped } = prepareFilesFromChanges(changes || []);
  const autoFindings = checks.runAll({ files, skipped });

  if (!files.length) {
    return {
      decision: 'APPROVE',
      summary: 'هیچ فایل قابل‌ریویویی در این MR نبود (همه‌ی تغییرات در فایل‌های تولیدشده/باینری/lockfile بودند).',
      findings: sortBySeverity(autoFindings),
      positives: [],
      stats: { files: 0, skipped: skipped.length, batches: 0, promptTokens: 0, completionTokens: 0, mode: 'agent' },
    };
  }

  const prompt = buildPrompt({ mr, files, skipped, diffText: buildDiffText(files) });
  const result = await runAgent({ cwd: worktreePath, prompt, model, signal });

  // The agent never got to look at anything (CLI missing, out of quota,
  // timed out). That's an engine-level failure, not a review — `engineError`
  // tells the caller to try another engine rather than hand back a review
  // that's really just the deterministic checks wearing a review's clothes.
  if (result.error) {
    return {
      engineError: result.error,
      decision: decide(autoFindings),
      summary: 'ریویوی ایجنتی ناموفق بود؛ فقط بررسی‌های خودکار انجام شد.',
      findings: sortBySeverity(autoFindings),
      positives: [],
      stats: { files: files.length, skipped: skipped.length, batches: 1, failedBatches: 1, promptTokens: 0, completionTokens: 0, mode: 'agent' },
    };
  }

  const parsed = parseJson(result.text);
  if (!parsed) {
    autoFindings.push({
      file: null, line: null, severity: 'Medium', category: 'process', source: 'auto',
      title: 'خروجی ایجنت قابل‌تجزیه نبود',
      note: 'ایجنت JSON معتبر برنگرداند. متن خام (بریده‌شده): ' + String(result.text || '').slice(0, 1500),
    });
  }

  const modelFindings = normalizeAgentFindings((parsed && parsed.findings) || [], files);
  const findings = sortBySeverity([...autoFindings, ...modelFindings]);

  return {
    decision: decide(findings),
    summary: (parsed && parsed.summary) || 'خلاصه‌ای ثبت نشد.',
    findings,
    positives: (parsed && Array.isArray(parsed.positives) ? parsed.positives.map(String).filter(Boolean) : []).slice(0, 8),
    stats: {
      files: files.length,
      skipped: skipped.length,
      batches: 1,
      turns: result.turns || null,
      costUsd: result.costUsd || null,
      promptTokens: (result.usage && result.usage.input_tokens) || 0,
      completionTokens: (result.usage && result.usage.output_tokens) || 0,
      mode: 'agent',
    },
  };
}

// The agent can legitimately report a finding about a line that isn't in the
// diff (a caller elsewhere that this change breaks) — that's the whole point
// of giving it the repo. So a line is marked verified only when it really is
// on the diff (inline comments need that), and everything else still travels
// in the report with its file/line intact instead of being thrown away.
function normalizeAgentFindings(raw, files) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  return (Array.isArray(raw) ? raw : []).map((r) => {
    const file = byPath.get(r.file) || byPath.get(String(r.file || '').replace(/^\.?\//, ''));
    const lineNum = Number(r.line);
    const onDiff = !!(file && Number.isFinite(lineNum) && file.lineMap.has(lineNum));
    return {
      file: r.file || (file ? file.path : null),
      line: onDiff ? lineNum : null,
      lineUnverified: !!(Number.isFinite(lineNum) && !onDiff),
      claimedLine: Number.isFinite(lineNum) ? lineNum : null,
      severity: ['High', 'Medium', 'Low'].includes(r.severity) ? r.severity : 'Medium',
      category: String(r.category || 'logic'),
      title: String(r.title || '').slice(0, 200) || 'یافته',
      note: String(r.note || '').slice(0, 2000),
      suggestion: r.suggestion ? String(r.suggestion).slice(0, 1200) : '',
      source: 'model',
    };
  });
}

const SEVERITY_ORDER = { High: 0, Medium: 1, Low: 2 };
function sortBySeverity(findings) {
  return findings.slice().sort((a, b) => {
    const s = (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3);
    return s !== 0 ? s : String(a.file || '').localeCompare(String(b.file || ''));
  });
}

function decide(findings) {
  return findings.some((f) => f.severity === 'High' || f.severity === 'Medium') ? 'REQUEST_CHANGES' : 'APPROVE';
}

// Same file preparation the batch path uses (skip lockfiles/generated/binary,
// build the line map inline comments need) — imported rather than duplicated
// would create a cycle, so it delegates to diff.js directly.
function prepareFilesFromChanges(changes) {
  const files = [];
  const skipped = [];
  for (const change of changes) {
    const filePath = change.new_path || change.old_path || '(unknown)';
    const verdict = diffLib.classify(change);
    if (verdict.skip) { skipped.push({ path: filePath, reason: verdict.reason }); continue; }
    files.push({
      path: filePath,
      oldPath: change.old_path || change.new_path,
      diff: change.diff,
      isNew: !!change.new_file,
      lineMap: diffLib.commentableLines(change.diff),
    });
  }
  return { files, skipped };
}

module.exports = { review, buildPrompt, parseJson, normalizeAgentFindings, prepareFilesFromChanges, AGENT_TIMEOUT_MS };
