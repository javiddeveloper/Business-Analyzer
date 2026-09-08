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

function buildMarkdown({ mrIid, mr, result, jiraIssue }) {
  const decisionIcon = result.decision === 'APPROVE' ? '✅' : '🔴';
  const findings = result.findings || [];
  const counts = findings.reduce((acc, f) => { acc[f.severity] = (acc[f.severity] || 0) + 1; return acc; }, {});

  const lines = [
    `# Code Review — MR !${mrIid}`,
    '',
    '> ⚠️ این فایل به‌صورت خودکار توسط Coder Review تولید می‌شود و در هر اجرای بعدی ریویو **کامل بازنویسی** می‌شود — یادداشت دستی اینجا نگه نمی‌دارد. اگر می‌خواهی چیزی برای همیشه بماند، آن را جای دیگری (مثلاً کامنت گیت‌لب یا کد) بنویس.',
    '',
    `**شاخه:** \`${mr.source_branch || '?'} → ${mr.target_branch || '?'}\``,
    mr.web_url ? `**لینک:** ${mr.web_url}` : '',
    `**نویسنده:** ${(mr.author && (mr.author.name || mr.author.username)) || '?'}`,
    `**تصمیم:** ${decisionIcon} ${result.decision}`,
    '',
    '| | |',
    '|---|---|',
    `| تاریخ ریویو | ${new Date().toISOString().slice(0, 19).replace('T', ' ')} |`,
    `| کامیت بررسی‌شده | \`${(mr.diff_refs && mr.diff_refs.head_sha || mr.sha || '').slice(0, 12)}\` |`,
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
    lines.push(
      '',
      '## تسک',
      '',
      `**${jiraIssue.key}** — ${jiraIssue.summary || '(بدون عنوان)'}`,
      '',
      `| وضعیت | مسئول | لینک |`,
      '|---|---|---|',
      `| ${jiraIssue.status || '—'} | ${jiraIssue.assignee || '—'} | ${jiraIssue.url || '—'} |`,
      '',
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
function writeReport({ projectPath, mrIid, mr, result, jiraIssue }) {
  try {
    const dir = reportDir(projectPath);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = reportPath(projectPath, mrIid);
    fs.writeFileSync(filePath, buildMarkdown({ mrIid, mr, result, jiraIssue }));
    return { path: filePath };
  } catch (e) {
    return { path: null, error: e.message };
  }
}

module.exports = { writeReport, buildMarkdown, reportPath, reportDir };
