// The review engine: turn an MR's changes into a list of findings.
//
// Shape of a finding (both model- and check-produced):
//   { file, line, severity: High|Medium|Low, category, title, note,
//     suggestion?, source: 'model'|'auto' }
const fs = require('fs');
const path = require('path');
const { callModel } = require('./ai_bridge');
const knowledge = require('./knowledge');
const diffLib = require('./diff');
const checks = require('./checks');
const contextBudget = require('./contextBudget');

const ROLE_PATH = path.join(__dirname, '..', 'roles', 'tech-lead.md');

// Per-request diff budget. Files are packed into batches under this size and
// each batch is reviewed in its own call, so a big MR is fully reviewed instead
// of silently cut off at the first N characters.
//
// The size now comes from lib/contextBudget.js rather than from a literal
// here, because a literal is necessarily wrong for three of the four engines:
// 14000 characters is a fifth of what Claude's 200K window could hold and
// more than a small model behind 9Router can take at all. The fallbacks below
// keep the old numbers, so a budget lookup that fails for any reason degrades
// to exactly the behaviour this file had before.
const FALLBACK_BATCH_CHARS = 14000;
const FALLBACK_FILE_CHARS = 9000;
const FALLBACK_FULL_FILE_CHARS = 4000;

// `provider` is passed through from review() so a run that fell back to a
// second engine (see the engine chain in jobs.js) is budgeted for the engine
// that actually ran it, not for the one that was configured and failed.
function sizeLimits(provider) {
  try {
    const b = contextBudget.budgetFor(provider);
    return { batch: b.batchChars, file: b.fileDiffChars, fullFile: b.fullFileChars };
  } catch (e) {
    return { batch: FALLBACK_BATCH_CHARS, file: FALLBACK_FILE_CHARS, fullFile: FALLBACK_FULL_FILE_CHARS };
  }
}
// Shared by both review paths (this file's batches and agentReview's agent
// run), because the artifact is the same in both: review/MR-<id>.md, which
// travels to the merge request's own branch.
//
// English, with two Persian exceptions — not a preference, but the team's
// documented standard (review/README.md in the reviewed project). An earlier
// pass here forced everything to Persian on the reasoning that the prompts
// and the dashboard are Persian; that was wrong, and it made the tool
// contradict the process it exists to automate. The model answering MR !191
// in English was following the rule, not breaking it.
//
// The two exceptions are both cases where the point is to make a *business*
// gap legible to the developer without making them read code first, so they
// are stated in plain Persian on purpose.
const OUTPUT_LANGUAGE_RULE = [
  'زبان گزارش انگلیسی است: summary، title، note و suggestion را انگلیسی بنویس.',
  'دقیقاً دو استثنا که باید فارسی نوشته شوند:',
  '  ۱) مغایرت جریان کسب‌وکار با پیاده‌سازی قدیمی (old_android)،',
  '  ۲) نبودِ تست برای یک سناریوی مهم کسب‌وکار.',
  'در این دو مورد، متن فارسی باید خودِ «کار» را به زبان ساده توضیح بدهد بدون اشاره به کد، تا توسعه‌دهنده فوراً بفهمد کدام رفتار جا افتاده است.',
].join('\n');

// Ceiling on how many calls one MR may cost. Beyond this the remaining files
// are reported as unreviewed rather than quietly ignored. Raised from the
// original 8 now that the default engine (claude-cli) is subscription-based
// rather than billed per token — a 49-file MR was silently dropping 33 files
// under the old cap. Still bounded, not unlimited: a truly enormous MR
// should be split up rather than reviewed in one shot regardless of engine.
const MAX_BATCHES = 24;
// How many batch calls run at once. Firing all of MAX_BATCHES in parallel
// would mean spawning up to 24 concurrent `claude` CLI processes (or 24
// simultaneous API calls) for one review — this paces it in waves instead,
// which matters most for claude-cli: a subscription's session limit is
// consumed by call volume, not tokens, so 24 near-simultaneous calls burns
// through it far faster than the same 24 calls spread over a few waves.
const BATCH_CONCURRENCY = 6;

const SEVERITY_ORDER = { High: 0, Medium: 1, Low: 2 };

function loadRole() {
  try { return fs.readFileSync(ROLE_PATH, 'utf8'); } catch (e) { return ''; }
}

// Split the MR's reviewable files into batches that each fit the budget.
function buildBatches(files, provider) {
  const limit = sizeLimits(provider).batch;
  const batches = [];
  let current = [];
  let size = 0;
  for (const file of files) {
    const chunkSize = file.annotated.length + (file.fullContent ? file.fullContent.length : 0);
    if (current.length && size + chunkSize > limit) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(file);
    size += chunkSize;
  }
  if (current.length) batches.push(current);
  return batches;
}

// fileContents: optional map of path -> full new-file text, from the local
// checkout (localRepo.js). Purely additive context; every finding still has
// to anchor to a real line of the diff itself (see normalizeFindings), so a
// model can't invent a finding "in the full file" that isn't in this MR.
function prepareFiles(changes, fileContents, provider) {
  const limits = sizeLimits(provider);
  const files = [];
  const skipped = [];
  for (const change of changes) {
    const filePath = change.new_path || change.old_path || '(unknown)';
    const verdict = diffLib.classify(change);
    if (verdict.skip) {
      skipped.push({ path: filePath, reason: verdict.reason });
      continue;
    }
    // Cut on a line boundary, never mid-line. A character cut leaves the last
    // annotated line as half a statement with a line number still attached,
    // which is precisely the kind of thing a model then reports a finding on.
    const cut = diffLib.annotateWithin(change.diff, limits.file);
    const annotated = cut.text;
    const truncated = cut.truncated;
    let fullContent = fileContents && fileContents[filePath];
    let fullContentTruncated = false;
    if (fullContent && fullContent.length > limits.fullFile) {
      fullContent = fullContent.slice(0, limits.fullFile) + '\n[... باقی فایل برای کنترل حجم حذف شد ...]';
      fullContentTruncated = true;
    }
    files.push({
      path: filePath,
      oldPath: change.old_path || change.new_path,
      diff: change.diff,
      annotated,
      truncated,
      fullContent: fullContent || null,
      fullContentTruncated,
      isNew: !!change.new_file,
      lineMap: diffLib.commentableLines(change.diff),
    });
  }
  return { files, skipped };
}

function buildSystemPrompt() {
  return [loadRole(), knowledge.contextBlock()].filter(Boolean).join('\n\n');
}

// The Jira ticket this MR belongs to, rendered for the prompt. Without it a
// review can only judge "is this code clean?"; with it, it can judge "does
// this code do what the task asked?" — which is the question a human
// reviewer actually opens the ticket to answer.
//
// The instruction is deliberately narrow: report a gap, don't redesign. A
// ticket's text is often stale or vaguer than the code, so the model is told
// to flag only a *concrete* mismatch, and those findings are pinned to Low
// severity in normalizeFindings so a wrong guess can never block an approve.
function jiraBlock(jiraIssue) {
  if (!jiraIssue || !jiraIssue.key) return '';
  return [
    '--- تسک جیرا (چیزی که این MR قرار بوده انجام دهد) ---',
    `کد تسک: ${jiraIssue.key}${jiraIssue.status ? ` (وضعیت: ${jiraIssue.status})` : ''}`,
    jiraIssue.summary ? `عنوان تسک: ${jiraIssue.summary}` : '',
    jiraIssue.description ? `شرح تسک:\n${String(jiraIssue.description).slice(0, 2500)}` : '',
    '',
    'اگر جایی از خواسته‌ی این تسک در کد پیاده نشده یا برخلافش پیاده شده، آن را با category برابر "task-mismatch" گزارش کن — فقط وقتی مغایرت مشخص و قابل‌اشاره است، نه حدس. شرح تسک ممکن است قدیمی یا ناقص باشد؛ بر اساس نبودِ چیزی در شرح تسک ایراد نگیر.',
    '--- پایان تسک جیرا ---',
    '',
  ].filter(Boolean).join('\n');
}

function buildUserPrompt({ mr, batch, batchIndex, batchCount, jiraIssue }) {
  const body = batch
    .map((f) => {
      const header = `### ${f.path}${f.isNew ? ' (فایل جدید)' : ''}${f.truncated ? ' (دیف بریده‌شده)' : ''}`;
      const full = f.fullContent
        ? `\n\nمتن کامل فایل بعد از این تغییر (فقط برای فهم زمینه — یافته باید همچنان به خطی از دیف بالا اشاره کند)${f.fullContentTruncated ? ' (بریده‌شده)' : ''}:\n${f.fullContent}`
        : '';
      return `${header}\n${f.annotated}${full}`;
    })
    .join('\n\n');

  return [
    `عنوان Merge Request: ${mr.title || ''}`,
    mr.description ? `توضیحات: ${String(mr.description).slice(0, 1500)}` : '',
    batchCount > 1 ? `(بخش ${batchIndex + 1} از ${batchCount} فایل‌های این MR)` : '',
    '',
    jiraBlock(jiraIssue),
    'قالب دیف: عدد سمت چپ هر خط، شماره‌ی همان خط در نسخه‌ی جدید فایل است. `+` یعنی خط اضافه‌شده، `-` حذف‌شده، بدون علامت یعنی خط زمینه (بدون تغییر).',
    '',
    'فقط درباره‌ی خطوطی نظر بده که در همین دیف هستند. برای هر یافته، دقیقاً همان عددی را بنویس که کنار آن خط آمده.',
    'خطوط زمینه فقط برای درک کد هستند؛ روی چیزی که این MR تغییرش نداده ایراد نگیر مگر آن‌که تغییرِ همین MR آن را واقعاً خراب کرده باشد.',
    '',
    'هر سه‌ی summary و findings و rating اجباری‌اند. rating را هرگز جا نینداز — بدون آن، این MR در ارزیابی «رتبه‌نشده» ثبت می‌شود.',
    // Stated, not merely implied by the prompt being in Persian: a Persian
    // prompt over an English codebase reliably comes back in English, which
    // is what MR !191 did. The reader of these findings is the MR author and
    // the report file, both Persian.
    OUTPUT_LANGUAGE_RULE,
    'خروجی را فقط و فقط به‌صورت یک JSON معتبر بده (بدون ```، بدون متن قبل و بعد):',
    '{',
    '  "summary": "۲ تا ۴ جمله درباره‌ی این تغییر و ریسک اصلی‌اش",',
    '  "findings": [',
    '    {',
    '      "file": "مسیر دقیق فایل از همین دیف",',
    '      "line": 123,',
    '      "severity": "High" | "Medium" | "Low",',
    '      "category": "logic" | "security" | "performance" | "error-handling" | "tests" | "style" | "knowledge-base" | "task-mismatch",',
    '      "title": "عنوان کوتاه",',
    '      "note": "چه اتفاقی می‌افتد و چرا مشکل است — با یک سناریوی مشخص شکست، نه یک نکته‌ی کلی",',
    '      "suggestion": "کد یا تغییر پیشنهادی (اختیاری)"',
    '    }',
    '  ],',
    '  "positives": ["اگر واقعاً چیز قابل‌ذکری در این بخش هست — مثلاً یک تست خوب، یک الگوی درست — در یکی دو جمله بگو؛ در غیر این‌صورت آرایه‌ی خالی"],',
    '  "rating": { "complexity": <عدد ۱ تا ۵>, "length": <عدد ۱ تا ۵> }',
    '}',
    '',
    'اگر هیچ مشکل واقعی ندیدی، آرایه‌ی findings را خالی بگذار. یافته‌ی الکی نساز تا دقیق به‌نظر برسی.',
    '',
    'rating دو محور مستقل است — یکی سختی، یکی حجم. یک تغییر یک‌خطی در قانون پرداخت complexity=4 و length=1 است؛ یک rename مکانیکی روی نود فایل complexity=1 و length=5.',
    'complexity (۱ تا ۵): ۱ خیلی راحت · ۲ معمولی، باگ/کار کوچک · ۳ ریسک بیزینسی واقعی · ۴ منطق ظریف، به‌راحتی اشتباه می‌شود · ۵ واقعاً سخت، نیاز به تخصص عمیق.',
    'length (۱ تا ۵): ۱ چند فایل · ۲ مجموعه‌ی کوچک · ۳ پخش متوسط · ۴ فایل زیاد و دیف بزرگ · ۵ این MR خیلی بزرگ است.',
    'خود تغییر را رتبه بده، نه نتیجه‌اش. اگر یک محور را نمی‌توانی قضاوت کنی، به‌جای حدس زدن null بگذار.',
    'اگر length را ۴ یا ۵ دادی، در summary هم بگو که این MR باید شکسته شود — در این اندازه هم ریویوی انسانی و هم خودکار عملاً چیزی پیدا نمی‌کنند.',
    '',
    body,
  ].filter(Boolean).join('\n');
}

function parseJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '');
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch (e) { return null; }
}

// One repair attempt when the model returns something that isn't JSON — the
// same self-correction idea business-generator uses with Zod, minus the
// dependency. Cheaper and far more likely to succeed than failing the review.
// The reply is a JSON findings list, and a reply cut off mid-array is not
// recoverable — it comes back as a parse failure and costs a repair round
// trip. So the cap comes from the engine's own output budget rather than one
// number that happened to suit whichever engine was configured when it was
// written.
function outputBudget(provider) {
  try {
    return contextBudget.budgetFor(provider).maxOutputTokens;
  } catch (e) {
    return 3000;
  }
}

async function callForJson({ system, user, signal, provider }) {
  const first = await callModel({ system, user, maxTokens: outputBudget(provider), signal, provider });
  if (first.error) return { error: first.error };
  const parsed = parseJson(first.text);
  if (parsed) return { parsed, usage: first.usage, repaired: false };

  const repair = await callModel({
    system,
    user: 'خروجی قبلی تو JSON معتبر نبود. دقیقاً همان محتوا را این بار فقط به‌صورت یک JSON معتبر بده، بدون هیچ متن اضافه:\n\n' + String(first.text || '').slice(0, 6000),
    maxTokens: 3000,
    signal,
    provider,
  });
  if (repair.error) return { error: repair.error };
  const reparsed = parseJson(repair.text);
  if (!reparsed) return { error: 'مدل خروجی JSON معتبر تولید نکرد.', rawText: first.text };
  return { parsed: reparsed, usage: repair.usage, repaired: true };
}

// Keep only findings that point at a real line of the diff. A model-invented
// line number would either land the comment on the wrong code or be rejected
// by GitLab, so it's dropped to a file-level finding instead of guessed at.
// The C/L rating the model returns. Clamped to 1-5 and to integers, and a
// missing or unusable axis stays null rather than defaulting — a rating of
// "easy" nobody made is worse than no rating at all, because lib/difficulty.js
// scores the absence as "not measured" and a bogus 1 as fact.
function normalizeRating(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const axis = (v) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 1 && n <= 5 ? n : null;
  };
  const complexity = axis(raw.complexity);
  const length = axis(raw.length);
  if (complexity == null && length == null) return null;
  return { complexity, length };
}

function normalizeFindings(rawFindings, batch) {
  const byPath = new Map(batch.map((f) => [f.path, f]));
  const out = [];
  for (const raw of Array.isArray(rawFindings) ? rawFindings : []) {
    const file = byPath.get(raw.file) || byPath.get(String(raw.file || '').replace(/^\.?\//, ''));
    const category = String(raw.category || 'logic');
    // "This doesn't match the ticket" is a judgement against a Jira
    // description that is regularly stale, half-written, or broader than the
    // one MR in front of us — useful as a prompt to a human, never solid
    // enough to hold up an approve on its own (decide() blocks on
    // High/Medium). Pinned to Low no matter what severity the model claims.
    const severity = category === 'task-mismatch'
      ? 'Low'
      : (['High', 'Medium', 'Low'].includes(raw.severity) ? raw.severity : 'Medium');
    const lineNum = Number(raw.line);
    const anchored = file && Number.isFinite(lineNum) && file.lineMap.has(lineNum);
    out.push({
      file: file ? file.path : (raw.file || null),
      line: anchored ? lineNum : null,
      lineUnverified: !!(Number.isFinite(lineNum) && !anchored),
      claimedLine: Number.isFinite(lineNum) ? lineNum : null,
      severity,
      category,
      title: String(raw.title || '').slice(0, 200) || 'یافته',
      note: String(raw.note || '').slice(0, 2000),
      suggestion: raw.suggestion ? String(raw.suggestion).slice(0, 1200) : '',
      source: 'model',
    });
  }
  return out;
}

// Runs `fn` over `items` with at most `limit` in flight at once — a simple
// worker-pool, not a wave-by-wave batch (a pool keeps every slot busy: as
// soon as one call finishes, the next queued item starts immediately,
// instead of waiting for the slowest item in a fixed-size wave before the
// next wave can begin).
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function sortFindings(findings) {
  return findings.slice().sort((a, b) => {
    const s = (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3);
    if (s !== 0) return s;
    // Within one severity, a finding about the code outranks a finding about
    // the review process itself ("this MR is too big", "n files were skipped"):
    // the reader's first question is what's wrong with the change, not what the
    // reviewer couldn't reach.
    const p = (a.category === 'process' ? 1 : 0) - (b.category === 'process' ? 1 : 0);
    if (p !== 0) return p;
    return String(a.file || '').localeCompare(String(b.file || ''));
  });
}

// Batches are reviewed independently and a shared file can appear in more than
// one of them, so the same problem legitimately comes back twice — as does the
// same file-level complaint ("no error handling here") from two calls. Without
// this, the report numbers one issue as two and the GitLab summary says it
// twice. Duplicates are folded into the first copy, keeping the strongest
// severity and whichever copy carries the most context (a line, a suggestion).
function dedupeKey(f) {
  return [
    f.file || '-',
    f.line == null ? '-' : f.line,
    String(f.title || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 120),
  ].join('|');
}

function dedupeFindings(findings) {
  const byKey = new Map();
  for (const f of findings) {
    const key = dedupeKey(f);
    const seen = byKey.get(key);
    if (!seen) { byKey.set(key, { ...f, duplicateCount: 1 }); continue; }
    seen.duplicateCount++;
    if ((SEVERITY_ORDER[f.severity] ?? 3) < (SEVERITY_ORDER[seen.severity] ?? 3)) seen.severity = f.severity;
    if (!seen.suggestion && f.suggestion) seen.suggestion = f.suggestion;
    if (String(f.note || '').length > String(seen.note || '').length) seen.note = f.note;
  }
  return [...byKey.values()];
}

// The verdict is derived from the findings, not asked of the model separately:
// a model that lists a High-severity bug and then says APPROVE is a
// contradiction that shouldn't be able to reach the MR.
function decide(findings) {
  return findings.some((f) => f.severity === 'High' || f.severity === 'Medium') ? 'REQUEST_CHANGES' : 'APPROVE';
}

// Everything the report needs to state precisely what this review did and did
// not look at. Carried on stats (rather than reconstructed by the report from
// the findings) because "which file was truncated" and "which file never
// reached the model" are facts only this module knows — and a coverage claim
// the reader can't check is worse than none.
function coverageStats({ files, skipped, dropped }) {
  return {
    reviewedFiles: files.map((f) => {
      const c = diffLib.countChanges(f.diff);
      return { path: f.path, added: c.added, removed: c.removed, isNew: !!f.isNew, truncated: !!f.truncated, hasFullContent: !!f.fullContent };
    }),
    skippedFiles: skipped.map((s) => ({ path: s.path, reason: s.reason })),
    droppedFiles: (dropped || []).map((f) => f.path),
  };
}

async function review({ mr, changes, fileContents, signal, provider, jiraIssue }) {
  const { files, skipped } = prepareFiles(changes || [], fileContents, provider);
  const autoFindings = checks.runAll({ files, skipped });

  if (!files.length) {
    return {
      decision: 'APPROVE',
      summary: 'هیچ فایل قابل‌ریویویی در این MR نبود (همه‌ی تغییرات در فایل‌های تولیدشده/باینری/lockfile بودند).',
      findings: sortFindings(autoFindings),
      positives: [],
      // No files reviewed means nothing to rate — not a rating of "easy".
      rating: null,
      stats: { files: 0, skipped: skipped.length, batches: 0, promptTokens: 0, completionTokens: 0, mode: 'batch', ...coverageStats({ files, skipped, dropped: [] }) },
    };
  }

  const allBatches = buildBatches(files, provider);
  const batches = allBatches.slice(0, MAX_BATCHES);
  const dropped = allBatches.slice(MAX_BATCHES).flat();
  const system = buildSystemPrompt();

  // Batches are independent — run them through a bounded worker pool instead
  // of serially (fast) or all-at-once (too many simultaneous CLI processes /
  // API calls — see BATCH_CONCURRENCY above).
  const results = await mapWithConcurrency(batches, BATCH_CONCURRENCY, (batch, i) =>
    callForJson({ system, user: buildUserPrompt({ mr, batch, batchIndex: i, batchCount: batches.length, jiraIssue }), signal, provider })
      .then((r) => ({ ...r, batch }))
      .catch((e) => {
        if (e.name === 'AbortError') throw e; // a stop request must cancel the whole review, not just one batch
        return { error: e.message, batch };
      })
  );

  const modelFindings = [];
  const summaries = [];
  const positives = [];
  const rating = { complexity: null, length: null };
  const errors = [];
  let promptTokens = 0;
  let completionTokens = 0;

  for (const result of results) {
    if (result.error) { errors.push(result.error); continue; }
    if (result.usage) {
      promptTokens += result.usage.promptTokens || 0;
      completionTokens += result.usage.completionTokens || 0;
    }
    if (result.parsed.summary) summaries.push(String(result.parsed.summary));
    if (Array.isArray(result.parsed.positives)) positives.push(...result.parsed.positives.map(String).filter(Boolean));
    // Each batch sees only part of the MR, so the highest rating any batch
    // gave wins: a diff is as long as its longest stretch and as delicate as
    // its most delicate corner, and averaging would let a pile of trivial
    // files talk down the one dangerous file among them.
    const r = normalizeRating(result.parsed.rating);
    if (r) {
      if (r.complexity != null) rating.complexity = Math.max(rating.complexity || 0, r.complexity);
      if (r.length != null) rating.length = Math.max(rating.length || 0, r.length);
    }
    modelFindings.push(...normalizeFindings(result.parsed.findings, result.batch));
  }

  if (dropped.length) {
    autoFindings.push({
      file: null, line: null, severity: 'Low', category: 'process', source: 'auto', coverage: true,
      title: `${dropped.length} فایل به دلیل سقف حجم ریویو نشد`,
      note: 'برای مهار هزینه، حداکثر ' + MAX_BATCHES + ' دسته در هر ریویو به مدل داده می‌شود. این فایل‌ها بررسی نشدند: ' + dropped.map((f) => `\`${f.path}\``).join('، '),
    });
  }

  // A model call failing is a fact about the review's completeness — the
  // report must say so rather than presenting a partial review as a full one.
  if (errors.length) {
    autoFindings.push({
      file: null, line: null, severity: 'Medium', category: 'process', source: 'auto', coverage: true,
      title: 'بخشی از ریویو به دلیل خطای مدل انجام نشد',
      note: 'خطاها: ' + errors.join(' | '),
    });
  }

  const findings = sortFindings(dedupeFindings([...autoFindings, ...modelFindings]));
  const summary = summaries.join(' ') ||
    (errors.length ? 'ریویوی مدل ناقص ماند؛ فقط بررسی‌های خودکار انجام شد.' : 'مشکل قابل‌ذکری در تغییرات پیدا نشد.');

  return {
    decision: decide(findings),
    summary,
    findings,
    positives: positives.slice(0, 8),
    // The merged C/L rating across every batch (see the max-merge above).
    rating: (rating.complexity || rating.length) ? rating : null,
    stats: {
      files: files.length,
      skipped: skipped.length,
      batches: batches.length,
      failedBatches: errors.length,
      promptTokens,
      completionTokens,
      mode: 'batch',
      ...coverageStats({ files, skipped, dropped }),
    },
  };
}

module.exports = { review, prepareFiles, buildBatches, buildUserPrompt, normalizeFindings, normalizeRating, decide, parseJson, sortFindings, dedupeFindings, coverageStats, mapWithConcurrency, MAX_BATCHES, BATCH_CONCURRENCY, OUTPUT_LANGUAGE_RULE };
