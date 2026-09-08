// Writes the review result to <PROJECT_PATH>/review/MR-<iid>.md — the same
// review/MR-<id>.md convention the team already uses for manual review
// reports, so this lands where a human reviewer would put one.
//
// This file is fully regenerated on every run (not hand-edited or merged
// round-over-round): keeping it a clean rebuild avoids the far worse failure
// mode of silently corrupting or half-clobbering a file a human might also be
// editing. The banner at the top says so explicitly, so nobody mistakes it
// for a hand-maintained document.
const fs = require('fs');
const path = require('path');

function reportDir(projectPath) {
  return path.join(projectPath, 'review');
}

function reportPath(projectPath, mrIid) {
  return path.join(reportDir(projectPath), `MR-${mrIid}.md`);
}

const SEVERITY_ICON = { High: '🔴', Medium: '🟠', Low: '🔵' };

function renderFinding(n, f) {
  const icon = SEVERITY_ICON[f.severity] || '🔵';
  const where = f.file ? (f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``) : '(کل MR)';
  const lines = [
    `## ${n}. ${f.title} — ${icon} ${f.severity}`,
    '',
    `**فایل:** ${where}`,
    '',
    f.note,
  ];
  if (f.lineUnverified && f.claimedLine) {
    lines.push('', `_(مدل به خط ${f.claimedLine} اشاره کرد که در دیف نبود — محل دقیق را دستی بررسی کن.)_`);
  }
  if (f.suggestion) {
    lines.push('', '**پیشنهاد:**', '```', f.suggestion, '```');
  }
  if (f.source === 'auto') lines.push('', '_(بررسی خودکار — الگوی قطعی، نه قضاوت مدل)_');
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

function buildMarkdown({ mrIid, mr, result, jiraIssue, commitStats }) {
  const decisionIcon = result.decision === 'APPROVE' ? '✅' : '🔴';
  const findings = result.findings || [];
  const counts = findings.reduce((acc, f) => { acc[f.severity] = (acc[f.severity] || 0) + 1; return acc; }, {});

  const lines = [
    `# Code Review — MR !${mrIid}`,
    '',
    '> ⚠️ این فایل به‌صورت خودکار توسط Coder Review تولید می‌شود و در هر اجرای بعدی ریویو **کامل بازنویسی** می‌شود — یادداشت دستی اینجا نگه نمی‌دارد. اگر می‌خواهی چیزی برای همیشه بماند، آن را جای دیگری (مثلاً کامنت گیت‌لب یا کد) بنویس.',
    '',
    `نویسنده: **${(mr.author && (mr.author.name || mr.author.username)) || '?'}**`,
    '',
    `شاخه‌ی مبدأ: **\`${mr.source_branch || '?'}\`**`,
    '',
    `شاخه‌ی مقصد: **\`${mr.target_branch || '?'}\`**`,
    '',
    mr.web_url ? `لینک Merge Request: ${mr.web_url}` : '',
    '',
    `**تصمیم:** ${decisionIcon} ${result.decision}`,
    '',
    '| | |',
    '|---|---|',
    `| تاریخ ریویو | ${new Date().toISOString().slice(0, 19).replace('T', ' ')} |`,
    `| کامیت بررسی‌شده | \`${(mr.diff_refs && mr.diff_refs.head_sha || mr.sha || '').slice(0, 12)}\` |`,
    ...renderCommitRows(commitStats),
    `| فایل‌های بررسی‌شده | ${result.stats.files} (${result.stats.skipped} رد شده) |`,
    `| یافته‌ها | 🔴 ${counts.High || 0} High · 🟠 ${counts.Medium || 0} Medium · 🔵 ${counts.Low || 0} Low |`,
    '',
    '---',
    '',
    '## خلاصه',
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
      `| ${jiraIssue.status || '—'} | ${jiraIssue.assignee || '—'} | ${est} | ${spent} | ${jiraIssue.dueDate || '—'} |`,
      '',
      // Only ~1 in 6 tickets here actually carries a description, so the
      // heading is printed only when there is something under it.
      ...(jiraIssue.description && jiraIssue.description.trim()
        ? ['**شرح تسک:**', '', jiraIssue.description.trim(), '']
        : ['_(این تسک در جیرا شرحی ندارد.)_', '']),
      '---',
    );
  }

  if (findings.length) {
    lines.push('', '## فهرست یافته‌ها', '', '| # | عنوان | فایل | شدت |', '|---|---|---|---|');
    findings.forEach((f, i) => {
      lines.push(`| ${i + 1} | ${f.title} | ${f.file ? '\`' + f.file + '\`' : '—'} | ${f.severity} |`);
    });
    lines.push('', '---', '');
    findings.forEach((f, i) => lines.push(renderFinding(i + 1, f), '---', ''));
  } else {
    lines.push('', 'هیچ یافته‌ای ثبت نشد.', '', '---', '');
  }

  if (result.positives && result.positives.length) {
    lines.push('## نکات مثبت', '');
    for (const p of result.positives) lines.push(`- ${p}`);
    lines.push('', '---', '');
  }

  lines.push(`<sub>تولید شده توسط Coder Review — ${new Date().toLocaleString('fa-IR')}</sub>`, '');
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
