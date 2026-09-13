// Writes the review result to <PROJECT_PATH>/review/MR-<iid>.md — the same
// review/MR-<id>.md convention the team already uses for manual review
// reports, so this lands where a human reviewer would put one.
//
// This file is fully regenerated on every run (not hand-edited or merged
// round-over-round): keeping it a clean rebuild avoids the far worse failure
// mode of silently corrupting or half-clobbering a file a human might also be
// editing. The banner at the top says so explicitly, so nobody mistakes it
// for a hand-maintained document.
//
// Layout follows the order the two readers actually read in:
//   1. the decision and the blocking items      (a lead deciding merge/no-merge)
//   2. what the change is, and what it was for  (context)
//   3. what this review did and did NOT cover   (how much to trust 1)
//   4. the findings themselves, model-judged and machine-checked kept apart
// Everything after the header is derived, never invented: if a fact isn't in
// the result, its section is omitted rather than filled with a guess.
const fs = require('fs');
const path = require('path');

// The team reads Jalali dates. Gregorian values from Jira/GitLab are
// converted here, at the point of display only — Intl does the calendar
// conversion natively, so there is no table to fall out of date.
const FA_DAY = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric', month: '2-digit', day: '2-digit' });

function faDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? String(iso) : FA_DAY.format(d);
}

function reportDir(projectPath) {
  return path.join(projectPath, 'review');
}

function reportPath(projectPath, mrIid) {
  return path.join(reportDir(projectPath), `MR-${mrIid}.md`);
}

const SEVERITY_ICON = { High: '🔴', Medium: '🟠', Low: '🔵' };
const SEVERITY_ORDER = { High: 0, Medium: 1, Low: 2 };

// The model answers with a machine category; the report shows the words the
// team uses. An unknown value is printed as-is rather than dropped — a new
// category should look odd, not disappear.
const CATEGORY_FA = {
  logic: 'منطق',
  security: 'امنیت',
  performance: 'کارایی',
  'error-handling': 'مدیریت خطا',
  tests: 'تست',
  style: 'خوانایی/سبک',
  'knowledge-base': 'استاندارد پروژه',
  'task-mismatch': 'مغایرت با تسک',
  cleanliness: 'تمیزی کد',
  process: 'فرآیند',
  auto: 'بررسی خودکار',
};

function categoryFa(category) {
  return CATEGORY_FA[category] || category || '—';
}

function where(f) {
  if (!f.file) return '(کل MR)';
  if (f.line) return `\`${f.file}:${f.line}\``;
  if (f.lineUnverified && f.claimedLine) return `\`${f.file}\` (ادعای مدل: خط ${f.claimedLine})`;
  return `\`${f.file}\``;
}

// A finding is only actionable if the reader can answer three questions from
// it: where, why it matters, and what to do. So each item always prints the
// location and the category, and says explicitly when there is no suggested
// fix — an empty space reads as "nothing to do", which is the wrong message.
function renderFinding(n, f) {
  const icon = SEVERITY_ICON[f.severity] || '🔵';
  const lines = [
    `### ${n}. ${f.title}`,
    '',
    `${icon} **${f.severity}** · ${categoryFa(f.category)} · ${where(f)}`,
    '',
    f.note,
  ];
  if (f.duplicateCount > 1) {
    lines.push('', `_(این مورد در ${f.duplicateCount} بخش از ریویو تکرار شده بود و اینجا یک‌بار آمده.)_`);
  }
  if (f.lineUnverified && f.claimedLine) {
    lines.push('', `_(مدل به خط ${f.claimedLine} اشاره کرد که در دیف نبود — محل دقیق را دستی بررسی کن.)_`);
  }
  if (f.suggestion) {
    lines.push('', '**پیشنهاد:**', '```', f.suggestion, '```');
  }
  lines.push('');
  return lines.join('\n');
}

// Commit history for the header table: how many commits, and how many came
// from someone other than the MR author — the same "round trip" signal the
// analytics page reports, but counted rather than reduced to yes/no.
function renderCommitRows(commitStats) {
  if (!commitStats) return [];
  const others = commitStats.otherAuthors || [];
  const otherCommits = others.reduce((sum, a) => sum + a.count, 0);
  return [
    `| تعداد کامیت‌ها | **${commitStats.total}** |`,
    `| رفت‌وبرگشت | ${otherCommits
      ? `**${otherCommits}** کامیت از ${others.length} نفر دیگر: ${others.map((a) => `${a.name} (${a.count})`).join('، ')}`
      : '**۰** — همه‌ی کامیت‌ها از خود نویسنده'} |`,
  ];
}

// "Agent" and "batch" are not a technical detail here: they are the single
// biggest factor in how much the findings below are worth. An agent review
// read the surrounding project; a batch review saw only the diff hunks. The
// reader has to be told which one produced this file.
function modeLine(stats) {
  if (stats.mode === 'agent') {
    return 'ایجنتی — کل پروژه روی همین کامیت چک‌اوت شد و مرورگر کد اجازه داشت فایل‌های اطراف، فراخوان‌ها و تست‌ها را هم بخواند.';
  }
  const batches = stats.batches ? ` (${stats.batches} دسته${stats.failedBatches ? `، ${stats.failedBatches} دسته ناموفق` : ''})` : '';
  return `دیفی${batches} — فقط دیف این MR (به‌همراه متن فایل‌های تغییریافته) به مدل داده شد؛ کد فراخوان‌ها و بقیه‌ی پروژه دیده نشده.`;
}

// The limits that hold for every run, whichever engine produced it. Stated
// once, plainly, so "the review said nothing about X" is never mistaken for
// "X is fine".
const ALWAYS_UNVERIFIED = [
  'بیلد و تست‌ها اجرا نشده‌اند — «کامپایل می‌شود» یا «تست‌ها سبزند» از این گزارش درنمی‌آید.',
  'رفتار زمان اجرا، کارایی واقعی و تجربه‌ی کاربری روی دستگاه بررسی نشده.',
  'این ریویو جای ریویوی انسانی را نمی‌گیرد؛ نبودِ یافته یعنی چیزی پیدا نشد، نه این‌که چیزی نیست.',
];

function renderCoverage(result, findings) {
  const stats = result.stats || {};
  const reviewed = Array.isArray(stats.reviewedFiles) ? stats.reviewedFiles : [];
  const skippedFiles = Array.isArray(stats.skippedFiles) ? stats.skippedFiles : [];
  const dropped = Array.isArray(stats.droppedFiles) ? stats.droppedFiles : [];
  const lines = ['## دامنه‌ی بررسی — چه دیده شد و چه دیده نشد', '', `**روش ریویو:** ${modeLine(stats)}`, ''];

  // Per-file breakdown: which files were actually looked at and what came out
  // of each. A file with a clean row is a real statement ("this was reviewed
  // and nothing was found"), which the old report couldn't make at all.
  if (reviewed.length) {
    const byFile = new Map();
    for (const f of findings) {
      if (!f.file) continue;
      const acc = byFile.get(f.file) || { High: 0, Medium: 0, Low: 0 };
      acc[f.severity] = (acc[f.severity] || 0) + 1;
      byFile.set(f.file, acc);
    }
    const MAX_ROWS = 50;
    lines.push('| فایل | تغییر | یافته‌ها |', '|---|---|---|');
    for (const file of reviewed.slice(0, MAX_ROWS)) {
      const c = byFile.get(file.path);
      const found = c
        ? [c.High && `🔴 ${c.High}`, c.Medium && `🟠 ${c.Medium}`, c.Low && `🔵 ${c.Low}`].filter(Boolean).join(' ')
        : '—';
      const flags = [file.isNew ? 'فایل جدید' : '', file.truncated ? 'دیف بریده‌شده' : ''].filter(Boolean);
      lines.push(`| \`${file.path}\`${flags.length ? ` _(${flags.join('، ')})_` : ''} | +${file.added}/-${file.removed} | ${found} |`);
    }
    if (reviewed.length > MAX_ROWS) lines.push(`| _و ${reviewed.length - MAX_ROWS} فایل دیگر_ | | |`);
    lines.push('');
  }

  if (skippedFiles.length) {
    lines.push(`**${skippedFiles.length} فایل اصلاً به ریویو نرسید** (فایل تولیدشده/باینری/lockfile یا حذف‌شده):`, '', '| فایل | دلیل |', '|---|---|');
    for (const s of skippedFiles.slice(0, 50)) lines.push(`| \`${s.path}\` | ${s.reason || '—'} |`);
    if (skippedFiles.length > 50) lines.push(`| _و ${skippedFiles.length - 50} فایل دیگر_ | |`);
    lines.push('');
  }

  if (dropped.length) {
    lines.push(`⚠️ **${dropped.length} فایل به دلیل سقف حجم ریویو نشد:** ${dropped.map((p) => `\`${p}\``).join('، ')}`, '');
  }

  // Coverage-tagged findings (failed model batches, skipped files, engine
  // fallbacks) belong to this section, not to the findings list — they say
  // something about the review, not about the code.
  const limits = findings.filter((f) => f.coverage);
  if (limits.length) {
    lines.push('**محدودیت‌های همین اجرا:**', '');
    for (const f of limits) lines.push(`- ${SEVERITY_ICON[f.severity] || '🔵'} **${f.title}** — ${String(f.note || '').split('\n').join(' ')}`);
    lines.push('');
  }

  lines.push('**در هیچ حالتی بررسی نشده:**', '');
  for (const item of ALWAYS_UNVERIFIED) lines.push(`- ${item}`);
  lines.push('', '---', '');
  return lines;
}

// The top-of-file answer to "do I merge this?": the verdict, why it says what
// it says, and the blocking items by name. Anything below is detail for
// whoever has to go fix them.
function renderExecutiveSummary({ decision, findings, counts }) {
  const blocking = findings.filter((f) => !f.coverage && (f.severity === 'High' || f.severity === 'Medium'));
  const minor = findings.filter((f) => !f.coverage && f.severity === 'Low');
  const lines = ['## چکیده', ''];

  if (decision === 'APPROVE') {
    lines.push(findings.length
      ? `موردی که جلوی merge را بگیرد پیدا نشد. ${minor.length} مورد کم‌اهمیت ثبت شده که می‌توانند در همین MR یا بعداً درست شوند.`
      : 'موردی که جلوی merge را بگیرد پیدا نشد و هیچ یافته‌ای ثبت نشد.');
  } else if (blocking.length) {
    lines.push(`این MR با **${blocking.length} مورد مسدودکننده** برگشت خورد (🔴 ${counts.High || 0} High · 🟠 ${counts.Medium || 0} Medium)${minor.length ? ` و ${minor.length} مورد کم‌اهمیت` : ''}. تا وقتی این‌ها باز هستند merge نکن:`, '');
    // Numbering matches the findings list below, so "مورد ۳" is unambiguous.
    findings.forEach((f, i) => {
      if (f.coverage || (f.severity !== 'High' && f.severity !== 'Medium')) return;
      lines.push(`- **مورد ${i + 1}** · ${SEVERITY_ICON[f.severity]} ${f.severity} · ${where(f)} — ${f.title}`);
    });
  } else {
    // REQUEST_CHANGES with nothing blocking in the code itself: the review
    // couldn't be completed. Saying "changes requested" without saying why
    // sends the author hunting for a bug that was never reported.
    lines.push('هیچ ایراد مسدودکننده‌ای در خود کد ثبت نشد؛ این تصمیم به‌خاطر ناقص‌ماندن خود ریویو است — بخش «دامنه‌ی بررسی» را ببین.');
  }

  lines.push('', '---', '');
  return lines;
}

function findingsTable(findings) {
  const rows = ['| # | شدت | دسته | یافته | فایل | منبع |', '|---|---|---|---|---|---|'];
  findings.forEach((f, i) => {
    if (f.coverage) return;
    rows.push(`| ${i + 1} | ${SEVERITY_ICON[f.severity] || '🔵'} ${f.severity} | ${categoryFa(f.category)} | ${f.title} | ${where(f)} | ${f.source === 'auto' ? 'خودکار' : 'مدل'} |`);
  });
  return rows;
}

function buildMarkdown({ mrIid, mr, result, jiraIssue, commitStats }) {
  const decisionIcon = result.decision === 'APPROVE' ? '✅' : '🔴';
  const stats = result.stats || {};
  // The engines sort before returning, but a caller can hand over anything —
  // and the numbering in the summary has to match the list, so sort here too.
  const findings = (result.findings || []).slice().sort((a, b) => {
    const s = (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3);
    if (s !== 0) return s;
    return (a.coverage ? 1 : 0) - (b.coverage ? 1 : 0);
  });
  const counts = findings.reduce((acc, f) => { acc[f.severity] = (acc[f.severity] || 0) + 1; return acc; }, {});
  const listed = findings.filter((f) => !f.coverage);
  const modelFindings = listed.filter((f) => f.source !== 'auto');
  const autoFindings = listed.filter((f) => f.source === 'auto');

  const lines = [
    `# Code Review — MR !${mrIid}`,
    '',
    '> ⚠️ این فایل به‌صورت خودکار توسط Coder Review تولید می‌شود و در هر اجرای بعدی ریویو **کامل بازنویسی** می‌شود — یادداشت دستی اینجا نگه نمی‌دارد. اگر می‌خواهی چیزی برای همیشه بماند، آن را جای دیگری (مثلاً کامنت گیت‌لب یا کد) بنویس.',
    '',
    `**تصمیم:** ${decisionIcon} ${result.decision}`,
    '',
    `نویسنده: **${(mr.author && (mr.author.name || mr.author.username)) || '?'}**`,
    '',
    `شاخه‌ی مبدأ: **\`${mr.source_branch || '?'}\`**`,
    '',
    `شاخه‌ی مقصد: **\`${mr.target_branch || '?'}\`**`,
    '',
    mr.web_url ? `لینک Merge Request: ${mr.web_url}` : '',
    '',
    '| | |',
    '|---|---|',
    `| تاریخ ریویو | ${new Date().toLocaleString('fa-IR')} |`,
    `| کامیت بررسی‌شده | \`${(mr.diff_refs && mr.diff_refs.head_sha || mr.sha || '').slice(0, 12)}\` |`,
    ...renderCommitRows(commitStats),
    `| فایل‌های بررسی‌شده | ${stats.files} (${stats.skipped} رد شده) |`,
    `| یافته‌ها | 🔴 ${counts.High || 0} High · 🟠 ${counts.Medium || 0} Medium · 🔵 ${counts.Low || 0} Low |`,
    `| روش ریویو | ${stats.mode === 'agent' ? 'ایجنتی (کل پروژه)' : 'دیفی (فقط دیف)'} |`,
    '',
    '---',
    '',
    ...renderExecutiveSummary({ decision: result.decision, findings, counts }),
    '## خلاصه‌ی تغییر',
    '',
    result.summary || '(خلاصه‌ای ثبت نشد)',
    '',
    '---',
  ];

  // The Jira ticket this MR implements, so whoever reads the report knows
  // what the change was *supposed* to do without opening Jira — the same
  // context the review itself was given (see reviewer.js's jiraBlock).
  // Omitted entirely when Jira isn't configured or the key isn't found,
  // rather than printing an empty section.
  if (jiraIssue && jiraIssue.key) {
    const est = jiraIssue.estimateHours != null ? `${jiraIssue.estimateHours} ساعت` : '—';
    const spent = jiraIssue.spentHours != null ? `${jiraIssue.spentHours} ساعت` : 'ثبت نشده';
    lines.push(
      '',
      '## تسک',
      '',
      `**${jiraIssue.key}** — ${jiraIssue.summary || '(بدون عنوان)'}`,
      '',
      `لینک تسک: ${jiraIssue.url || '—'}`,
      '',
      '| وضعیت | مسئول | تخمین | زمان ثبت‌شده | سررسید |',
      '|---|---|---|---|---|',
      `| ${jiraIssue.status || '—'} | ${jiraIssue.assignee || '—'} | ${est} | ${spent} | ${jiraIssue.dueDate ? faDate(jiraIssue.dueDate) : '—'} |`,
      '',
      // Only ~1 in 6 tickets here actually carries a description, so the
      // heading is printed only when there is something under it.
      ...(jiraIssue.description && jiraIssue.description.trim()
        ? ['**شرح تسک:**', '', jiraIssue.description.trim(), '']
        : ['_(این تسک در جیرا شرحی ندارد.)_', '']),
      '---',
    );
  }

  lines.push('', ...renderCoverage(result, findings));

  if (listed.length) {
    lines.push('## فهرست یافته‌ها', '', ...findingsTable(findings), '');
    lines.push(
      '**راهنمای شدت** — 🔴 High: رفتار غلط یا از دست رفتن داده در مسیر عادی، یا حفره‌ی امنیتی · 🟠 Medium: شکست در حالت خاص، مدیریت‌نشدن خطا، یا اثر بیرون از دامنه‌ی همین تغییر · 🔵 Low: خوانایی، یکدستی، بدهی فنی، نبود تست.',
      '',
      '---',
      ''
    );
  }

  // Model judgement and machine-checked patterns are deliberately in two
  // sections: a regex match is a fact ("this line matches an AWS key"), a
  // model finding is an opinion that can be wrong. Mixing them into one
  // numbered list makes the reader weigh them the same, which is how a
  // false positive ends up treated as a certainty — and a real credential
  // leak ends up buried between two style nits.
  if (modelFindings.length) {
    lines.push('## یافته‌های ریویو (قضاوت مدل)', '');
    for (const f of modelFindings) lines.push(renderFinding(findings.indexOf(f) + 1, f), '');
    lines.push('---', '');
  }

  if (autoFindings.length) {
    lines.push(
      '## بررسی‌های خودکار (الگوی قطعی، نه قضاوت مدل)',
      '',
      '_این موارد را یک الگوی قطعی پیدا کرده، نه مدل: روی هر اجرا و روی همه‌ی فایل‌ها یکسان اجرا می‌شوند، حتی فایل‌هایی که به مدل نرسیدند._',
      ''
    );
    for (const f of autoFindings) lines.push(renderFinding(findings.indexOf(f) + 1, f), '');
    lines.push('---', '');
  }

  if (!listed.length) lines.push('هیچ یافته‌ای ثبت نشد.', '', '---', '');

  if (result.positives && result.positives.length) {
    lines.push('## نکات مثبت', '');
    for (const p of result.positives) lines.push(`- ${p}`);
    lines.push('', '---', '');
  }


  lines.push(
    '<sub>' +
      `تولید شده توسط Coder Review — ${new Date().toLocaleString('fa-IR')}` +
      (stats.batches ? ` · ${stats.batches} دسته` : '') +
      (stats.promptTokens || stats.completionTokens ? ` · توکن: ${stats.promptTokens}+${stats.completionTokens}` : '') +
      '</sub>',
    ''
  );
  // The C/L rating goes last — literally the final line of the file, because
  // that is where the team's convention puts it and where anyone reading the
  // file by eye expects to find it. lib/difficulty.js scans the tail rather
  // than only the final line, but matching the convention exactly keeps the
  // file readable by a person and by `tail -1` alike.
  //
  // Written only when the review actually produced a rating: a line invented
  // here would be read back later as a maintainer's judgement, which it is not.
  if (result.rating && (result.rating.complexity || result.rating.length)) {
    const parts = [];
    if (result.rating.complexity) parts.push('C' + '*'.repeat(result.rating.complexity));
    if (result.rating.length) parts.push('L' + '*'.repeat(result.rating.length));
    lines.push('<sub>C = پیچیدگی · L = حجم کدی که باید خوانده شود (۱ تا ۵)</sub>', '', parts.join(' '), '');
  }

  return lines.filter((l, i, arr) => !(l === '' && arr[i - 1] === '')).join('\n');
}

// Returns { path } on success, or { path: null, error } if the write failed
// (e.g. no permission, disk full) — a report-writing failure must not fail
// the whole review, since the GitLab comment/dashboard result is still valid.
function writeReport({ projectPath, mrIid, mr, result, jiraIssue, commitStats }) {
  try {
    const dir = reportDir(projectPath);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = reportPath(projectPath, mrIid);
    fs.writeFileSync(filePath, buildMarkdown({ mrIid, mr, result, jiraIssue, commitStats }));
    return { path: filePath };
  } catch (e) {
    return { path: null, error: e.message };
  }
}

module.exports = { writeReport, buildMarkdown, reportPath, reportDir };
