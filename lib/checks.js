// Deterministic checks that run alongside the model.
//
// Why not leave all of this to the LLM: a leaked credential is exactly the kind
// of finding that must never depend on whether the model happened to notice it
// this time. A regex either matches or it doesn't, on every run, for every file
// — including the ones that got dropped from the model's context budget.
//
// These findings are marked source:'auto' so the report can distinguish "a
// pattern matched" from "a model judged".
const diffLib = require('./diff');

const SECRET_PATTERNS = [
  { id: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/, label: 'AWS access key id' },
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, label: 'بلوک private key' },
  { id: 'gitlab-pat', re: /\bglpat-[A-Za-z0-9_-]{20,}/, label: 'GitLab access token' },
  { id: 'github-pat', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/, label: 'GitHub token' },
  { id: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/, label: 'Slack token' },
  { id: 'google-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/, label: 'Google API key' },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, label: 'JWT' },
  {
    id: 'hardcoded-credential',
    re: /(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\s*[:=]\s*["'][^"'\s]{8,}["']/i,
    label: 'اعتبارنامه‌ی هاردکد',
    // Only for this pattern: a value that clearly isn't a real secret.
    // Without it, every `password = BuildConfig.PASSWORD` and every
    // `apiKey: "<your-key-here>"` in a sample file becomes a false alarm,
    // and a checker that cries wolf gets ignored — including the real one.
    ignore: /process\.env|System\.getenv|os\.environ|getenv|BuildConfig|Secrets?\.|Config\.|\$\{|\$\(|<[^>]*>|your[_-]|example|sample|placeholder|changeme|dummy|redacted|xxx+|\*{3,}|\.{3,}/i,
  },
];

const DEBUG_PATTERNS = [
  { re: /\bconsole\.(log|debug|warn|error)\s*\(/, label: 'console log' },
  { re: /\bdebugger\s*;?/, label: 'debugger statement' },
  { re: /\bSystem\.out\.print/, label: 'System.out.print' },
  { re: /\bprintStackTrace\s*\(/, label: 'printStackTrace' },
  { re: /\bvar_dump\s*\(|\bdd\s*\(/, label: 'debug dump' },
  { re: /\bprintln\s*\(/, label: 'println' },
];

const TODO_PATTERN = /(^|[^\w])(TODO|FIXME|HACK|XXX)\b/;

// A conflict marker that survived a merge/rebase. Deterministic on purpose:
// this never compiles, it is never a judgement call, and it is exactly the
// kind of thing a model reading one diff hunk in isolation reads straight
// past. The `<<<<<<< ` and `>>>>>>> ` forms require a branch name after them
// so an ASCII banner or a test fixture full of angle brackets doesn't match.
const CONFLICT_MARKER = /^(?:<{7} \S|={7}$|>{7} \S)/;

function finding(f) {
  return { severity: 'Low', category: 'auto', source: 'auto', ...f };
}

// Secrets are checked on ADDED lines only: a credential that was already in the
// file isn't this MR's finding, and flagging it every round would drown the
// things the author can actually act on.
function scanSecrets(files) {
  const out = [];
  for (const file of files) {
    for (const { line, text } of diffLib.addedLines(file.diff)) {
      for (const pattern of SECRET_PATTERNS) {
        if (!pattern.re.test(text)) continue;
        if (pattern.ignore && pattern.ignore.test(text)) continue;
        out.push(finding({
          file: file.path,
          line,
          severity: 'High',
          category: 'security',
          title: `احتمال لو رفتن اعتبارنامه (${pattern.label})`,
          note: `این خط شبیه یک ${pattern.label} واقعی است که مستقیم داخل کد نوشته شده. اگر واقعاً اعتبارنامه است، باید از کد خارج شود (متغیر محیطی / سرویس مدیریت راز) و مقدارِ لو رفته باطل (revoke) شود — پاک کردنش در کامیت بعدی کافی نیست، چون در تاریخچه‌ی گیت می‌ماند.`,
        }));
        break; // one finding per line is enough
      }
    }
  }
  return out;
}

function scanDebugLeftovers(files) {
  const out = [];
  for (const file of files) {
    if (diffLib.isTestPath(file.path)) continue; // debug output in tests is normal
    for (const { line, text } of diffLib.addedLines(file.diff)) {
      const hit = DEBUG_PATTERNS.find((p) => p.re.test(text));
      if (hit) {
        out.push(finding({
          file: file.path,
          line,
          category: 'cleanliness',
          title: `خروجی دیباگ جامانده (${hit.label})`,
          note: 'این خط خروجی دیباگ است. اگر عمدی و لازم است، از لاگر پروژه با سطح مناسب استفاده کن؛ وگرنه قبل از merge حذفش کن.',
        }));
        continue;
      }
      if (TODO_PATTERN.test(text)) {
        out.push(finding({
          file: file.path,
          line,
          category: 'cleanliness',
          title: 'نشانه‌ی TODO/FIXME اضافه‌شده',
          note: 'کار ناتمامی در همین MR اضافه شده. یا قبل از merge تمامش کن، یا به یک تیکت وصلش کن تا گم نشود.',
        }));
      }
    }
  }
  return out;
}

// A change that adds/modifies real source code but touches no test at all.
// One finding for the whole MR, not per file — per file it would be noise.
// Conflict markers are checked on added lines of every file, tests included:
// a marker in a test file is just as broken as one in production code.
function scanConflictMarkers(files) {
  const out = [];
  for (const file of files) {
    for (const { line, text } of diffLib.addedLines(file.diff)) {
      if (!CONFLICT_MARKER.test(text)) continue;
      out.push(finding({
        file: file.path,
        line,
        severity: 'High',
        category: 'logic',
        title: 'نشانه‌ی conflict حل‌نشده در کد',
        note: 'این خط یک نشانه‌ی merge conflict (`<<<<<<<` / `=======` / `>>>>>>>`) است که در کامیت باقی مانده. فایل در این حالت کامپایل/اجرا نمی‌شود؛ نتیجه‌ی merge را دستی درست کن و دوباره کامیت کن.',
      }));
      break; // one marker per file is enough to send the author back to the file
    }
  }
  return out;
}

function checkMissingTests(files) {
  const source = files.filter((f) => diffLib.isSourcePath(f.path) && !diffLib.isTestPath(f.path));
  const tests = files.filter((f) => diffLib.isTestPath(f.path));
  if (!source.length || tests.length) return [];
  const added = source.reduce((sum, f) => sum + diffLib.countChanges(f.diff).added, 0);
  // Tiny changes (a string, a constant) don't need a test to justify themselves.
  if (added < 30) return [];
  return [finding({
    file: source[0].path,
    line: null,
    category: 'tests',
    title: 'هیچ تستی در این MR تغییر نکرده',
    note: `این MR حدود ${added} خط کد اصلی اضافه/تغییر داده اما هیچ فایل تستی را لمس نکرده. اگر منطق قابل‌تست اضافه شده، تستش را هم اضافه کن؛ اگر واقعاً تست لازم ندارد (مثلاً فقط تغییر UI یا ثابت)، در توضیح MR بگو چرا.`,
  })];
}

function checkSize(files, skipped) {
  const out = [];
  const totals = files.reduce(
    (acc, f) => {
      const c = diffLib.countChanges(f.diff);
      acc.added += c.added;
      acc.removed += c.removed;
      return acc;
    },
    { added: 0, removed: 0 }
  );
  if (files.length > 40 || totals.added > 1500) {
    out.push(finding({
      file: null,
      line: null,
      severity: 'Medium',
      category: 'process',
      title: 'این MR برای یک ریویوی دقیق خیلی بزرگ است',
      note: `${files.length} فایل و +${totals.added}/-${totals.removed} خط. در این اندازه، هم ریویوی انسانی و هم ریویوی خودکار کیفیتشان افت می‌کند. اگر می‌شود به چند MR کوچک‌تر بشکنش.`,
    }));
  }
  if (skipped.length) {
    out.push(finding({
      file: null,
      line: null,
      severity: 'Low',
      category: 'process',
      // coverage:true — this is a statement about the review's reach, not a
      // defect in the code. The report file renders it in its coverage
      // section (with the full per-file table) instead of numbering it among
      // the findings, so the same fact isn't told twice.
      coverage: true,
      title: `${skipped.length} فایل بررسی نشد`,
      note: 'این فایل‌ها به مدل داده نشدند: ' + skipped.map((s) => `\`${s.path}\` (${s.reason})`).join('، '),
    }));
  }
  return out;
}

function runAll({ files, skipped }) {
  return [
    ...scanSecrets(files),
    ...scanConflictMarkers(files),
    ...scanDebugLeftovers(files),
    ...checkMissingTests(files),
    ...checkSize(files, skipped || []),
  ];
}

module.exports = { runAll, scanSecrets, scanConflictMarkers, scanDebugLeftovers, checkMissingTests, checkSize };
