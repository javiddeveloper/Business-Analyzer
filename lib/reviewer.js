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

const ROLE_PATH = path.join(__dirname, '..', 'roles', 'tech-lead.md');

// Per-request diff budget. Files are packed into batches under this size and
// each batch is reviewed in its own call, so a big MR is fully reviewed instead
// of silently cut off at the first N characters.
const BATCH_CHARS = 14000;
// Ceiling on how many calls one MR may cost. Beyond this the remaining files
// are reported as unreviewed rather than quietly ignored.
const MAX_BATCHES = 8;
// A single file bigger than this is truncated (with a marker) so one huge file
// can't monopolise a batch.
const MAX_FILE_CHARS = 9000;
// Full-file content (from the local checkout, see localRepo.js) is extra
// context on top of the diff hunk — capped separately and smaller, since a
// batch already has to fit the diff annotations of every file in it too.
const MAX_FULL_FILE_CHARS = 4000;

const SEVERITY_ORDER = { High: 0, Medium: 1, Low: 2 };

function loadRole() {
  try { return fs.readFileSync(ROLE_PATH, 'utf8'); } catch (e) { return ''; }
}

// Split the MR's reviewable files into batches that each fit the budget.
function buildBatches(files) {
  const batches = [];
  let current = [];
  let size = 0;
  for (const file of files) {
    const chunkSize = file.annotated.length + (file.fullContent ? file.fullContent.length : 0);
    if (current.length && size + chunkSize > BATCH_CHARS) {
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
function prepareFiles(changes, fileContents) {
  const files = [];
  const skipped = [];
  for (const change of changes) {
    const filePath = change.new_path || change.old_path || '(unknown)';
    const verdict = diffLib.classify(change);
    if (verdict.skip) {
      skipped.push({ path: filePath, reason: verdict.reason });
      continue;
    }
    let annotated = diffLib.annotate(change.diff);
    let truncated = false;
    if (annotated.length > MAX_FILE_CHARS) {
      annotated = annotated.slice(0, MAX_FILE_CHARS) + '\n[... ادامه‌ی این فایل به دلیل حجم بریده شد ...]';
      truncated = true;
    }
    let fullContent = fileContents && fileContents[filePath];
    let fullContentTruncated = false;
    if (fullContent && fullContent.length > MAX_FULL_FILE_CHARS) {
      fullContent = fullContent.slice(0, MAX_FULL_FILE_CHARS) + '\n[... باقی فایل برای کنترل حجم حذف شد ...]';
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

function buildUserPrompt({ mr, batch, batchIndex, batchCount }) {
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
    'قالب دیف: عدد سمت چپ هر خط، شماره‌ی همان خط در نسخه‌ی جدید فایل است. `+` یعنی خط اضافه‌شده، `-` حذف‌شده، بدون علامت یعنی خط زمینه (بدون تغییر).',
    '',
    'فقط درباره‌ی خطوطی نظر بده که در همین دیف هستند. برای هر یافته، دقیقاً همان عددی را بنویس که کنار آن خط آمده.',
    'خطوط زمینه فقط برای درک کد هستند؛ روی چیزی که این MR تغییرش نداده ایراد نگیر مگر آن‌که تغییرِ همین MR آن را واقعاً خراب کرده باشد.',
    '',
    'خروجی را فقط و فقط به‌صورت یک JSON معتبر بده (بدون ```، بدون متن قبل و بعد):',
    '{',
    '  "summary": "۲ تا ۴ جمله درباره‌ی این تغییر و ریسک اصلی‌اش",',
    '  "findings": [',
    '    {',
    '      "file": "مسیر دقیق فایل از همین دیف",',
    '      "line": 123,',
    '      "severity": "High" | "Medium" | "Low",',
    '      "category": "logic" | "security" | "performance" | "error-handling" | "tests" | "style" | "knowledge-base",',
    '      "title": "عنوان کوتاه",',
    '      "note": "چه اتفاقی می‌افتد و چرا مشکل است — با یک سناریوی مشخص شکست، نه یک نکته‌ی کلی",',
    '      "suggestion": "کد یا تغییر پیشنهادی (اختیاری)"',
    '    }',
    '  ],',
    '  "positives": ["اگر واقعاً چیز قابل‌ذکری در این بخش هست — مثلاً یک تست خوب، یک الگوی درست — در یکی دو جمله بگو؛ در غیر این‌صورت آرایه‌ی خالی"]',
    '}',
    '',
    'اگر هیچ مشکل واقعی ندیدی، آرایه‌ی findings را خالی بگذار. یافته‌ی الکی نساز تا دقیق به‌نظر برسی.',
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
async function callForJson({ system, user, signal }) {
  const first = await callModel({ system, user, maxTokens: 3000, signal });
  if (first.error) return { error: first.error };
  const parsed = parseJson(first.text);
  if (parsed) return { parsed, usage: first.usage, repaired: false };

  const repair = await callModel({
    system,
    user: 'خروجی قبلی تو JSON معتبر نبود. دقیقاً همان محتوا را این بار فقط به‌صورت یک JSON معتبر بده، بدون هیچ متن اضافه:\n\n' + String(first.text || '').slice(0, 6000),
    maxTokens: 3000,
    signal,
  });
  if (repair.error) return { error: repair.error };
  const reparsed = parseJson(repair.text);
  if (!reparsed) return { error: 'مدل خروجی JSON معتبر تولید نکرد.', rawText: first.text };
  return { parsed: reparsed, usage: repair.usage, repaired: true };
}

// Keep only findings that point at a real line of the diff. A model-invented
// line number would either land the comment on the wrong code or be rejected
// by GitLab, so it's dropped to a file-level finding instead of guessed at.
function normalizeFindings(rawFindings, batch) {
  const byPath = new Map(batch.map((f) => [f.path, f]));
  const out = [];
  for (const raw of Array.isArray(rawFindings) ? rawFindings : []) {
    const file = byPath.get(raw.file) || byPath.get(String(raw.file || '').replace(/^\.?\//, ''));
    const severity = ['High', 'Medium', 'Low'].includes(raw.severity) ? raw.severity : 'Medium';
    const lineNum = Number(raw.line);
    const anchored = file && Number.isFinite(lineNum) && file.lineMap.has(lineNum);
    out.push({
      file: file ? file.path : (raw.file || null),
      line: anchored ? lineNum : null,
      lineUnverified: !!(Number.isFinite(lineNum) && !anchored),
      claimedLine: Number.isFinite(lineNum) ? lineNum : null,
      severity,
      category: String(raw.category || 'logic'),
      title: String(raw.title || '').slice(0, 200) || 'یافته',
      note: String(raw.note || '').slice(0, 2000),
      suggestion: raw.suggestion ? String(raw.suggestion).slice(0, 1200) : '',
      source: 'model',
    });
  }
  return out;
}

function sortFindings(findings) {
  return findings.slice().sort((a, b) => {
    const s = (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3);
    if (s !== 0) return s;
    return String(a.file || '').localeCompare(String(b.file || ''));
  });
}

// The verdict is derived from the findings, not asked of the model separately:
// a model that lists a High-severity bug and then says APPROVE is a
// contradiction that shouldn't be able to reach the MR.
function decide(findings) {
  return findings.some((f) => f.severity === 'High' || f.severity === 'Medium') ? 'REQUEST_CHANGES' : 'APPROVE';
}

async function review({ mr, changes, fileContents, signal }) {
  const { files, skipped } = prepareFiles(changes || [], fileContents);
  const autoFindings = checks.runAll({ files, skipped });

  if (!files.length) {
    return {
      decision: 'APPROVE',
      summary: 'هیچ فایل قابل‌ریویویی در این MR نبود (همه‌ی تغییرات در فایل‌های تولیدشده/باینری/lockfile بودند).',
      findings: sortFindings(autoFindings),
      positives: [],
      stats: { files: 0, skipped: skipped.length, batches: 0, promptTokens: 0, completionTokens: 0 },
    };
  }

  const allBatches = buildBatches(files);
  const batches = allBatches.slice(0, MAX_BATCHES);
  const dropped = allBatches.slice(MAX_BATCHES).flat();
  const system = buildSystemPrompt();

  // Batches are independent — run them together instead of serially, so a
  // 6-batch MR takes one model round-trip's time, not six.
  const results = await Promise.all(
    batches.map((batch, i) =>
      callForJson({ system, user: buildUserPrompt({ mr, batch, batchIndex: i, batchCount: batches.length }), signal })
        .then((r) => ({ ...r, batch }))
        .catch((e) => {
          if (e.name === 'AbortError') throw e; // a stop request must cancel the whole review, not just one batch
          return { error: e.message, batch };
        })
    )
  );

  const modelFindings = [];
  const summaries = [];
  const positives = [];
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
    modelFindings.push(...normalizeFindings(result.parsed.findings, result.batch));
  }

  if (dropped.length) {
    autoFindings.push({
      file: null, line: null, severity: 'Low', category: 'process', source: 'auto',
      title: `${dropped.length} فایل به دلیل سقف حجم ریویو نشد`,
      note: 'برای مهار هزینه، حداکثر ' + MAX_BATCHES + ' دسته در هر ریویو به مدل داده می‌شود. این فایل‌ها بررسی نشدند: ' + dropped.map((f) => `\`${f.path}\``).join('، '),
    });
  }

  // A model call failing is a fact about the review's completeness — the
  // report must say so rather than presenting a partial review as a full one.
  if (errors.length) {
    autoFindings.push({
      file: null, line: null, severity: 'Medium', category: 'process', source: 'auto',
      title: 'بخشی از ریویو به دلیل خطای مدل انجام نشد',
      note: 'خطاها: ' + errors.join(' | '),
    });
  }

  const findings = sortFindings([...autoFindings, ...modelFindings]);
  const summary = summaries.join(' ') ||
    (errors.length ? 'ریویوی مدل ناقص ماند؛ فقط بررسی‌های خودکار انجام شد.' : 'مشکل قابل‌ذکری در تغییرات پیدا نشد.');

  return {
    decision: decide(findings),
    summary,
    findings,
    positives: positives.slice(0, 8),
    stats: {
      files: files.length,
      skipped: skipped.length,
      batches: batches.length,
      failedBatches: errors.length,
      promptTokens,
      completionTokens,
    },
  };
}

module.exports = { review, prepareFiles, buildBatches, normalizeFindings, decide, parseJson, sortFindings };
