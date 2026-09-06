// Turning findings into comments on the merge request.
//
// Two problems this solves beyond "post a comment":
//
// 1. Inline placement — a finding about line 42 belongs on line 42, where the
//    author reads it, not in a wall of text at the bottom of the MR.
//
// 2. Repetition across rounds — a re-review of the next push would otherwise
//    re-post every still-open finding. Each comment carries an invisible
//    fingerprint marker; before posting, the MR's existing comments are read
//    and anything already said is skipped. That's what makes automatic
//    re-review on every push tolerable instead of spam.
const crypto = require('crypto');
const gitlab = require('./gitlab');

// Cap on inline comments per run. Past this the remaining findings still
// appear in the summary — 30 inline threads on one MR is not a review anyone
// reads, it's a wall.
const MAX_INLINE = 20;

const SEVERITY_ICON = { High: '🔴', Medium: '🟠', Low: '🔵' };

function fingerprint(finding) {
  const basis = [
    finding.file || '-',
    finding.line == null ? '-' : finding.line,
    (finding.title || '').trim().toLowerCase().slice(0, 120),
  ].join('|');
  return crypto.createHash('sha1').update(basis).digest('hex').slice(0, 12);
}

function marker(fp) {
  return `<!-- coder-review:${fp} -->`;
}

// Every marker this bot has already left on the MR, from both inline
// discussions and plain notes.
async function existingMarkers(projectId, mrIid) {
  const found = new Set();
  const collect = (body) => {
    // The character class must allow '-': the summary marker is
    // "summary-<sha>", and without it every re-review posted a second summary.
    for (const m of String(body || '').matchAll(/<!-- coder-review:([a-z0-9-]+) -->/g)) found.add(m[1]);
  };
  try {
    for (const discussion of await gitlab.listDiscussions(projectId, mrIid)) {
      for (const note of discussion.notes || []) collect(note.body);
    }
  } catch (e) {
    // Can't read history → fall back to posting. A duplicate comment is a far
    // smaller failure than silently dropping a real finding.
    console.error('[publish] could not read existing discussions:', e.message);
  }
  return found;
}

function renderFinding(finding) {
  const icon = SEVERITY_ICON[finding.severity] || '🔵';
  const where = finding.line ? `\`${finding.file}:${finding.line}\`` : finding.file ? `\`${finding.file}\`` : '';
  const lines = [
    `${icon} **${finding.severity} · ${finding.category}** — ${finding.title}`,
    '',
    finding.note,
  ];
  if (finding.lineUnverified && finding.claimedLine) {
    lines.push('', `_(مدل به خط ${finding.claimedLine} اشاره کرد، ولی آن خط در این دیف نبود — محل دقیق را خودت تأیید کن.)_`);
  }
  if (finding.suggestion) {
    lines.push('', '**پیشنهاد:**', '```', finding.suggestion, '```');
  }
  if (!finding.line && where) lines.splice(1, 0, where);
  if (finding.source === 'auto') lines.push('', '_بررسی خودکار (الگوی قطعی، نه قضاوت مدل)_');
  return lines.join('\n');
}

function buildSummary({ decision, summary, findings, stats, inlineCount, headSha, model }) {
  const counts = findings.reduce((acc, f) => { acc[f.severity] = (acc[f.severity] || 0) + 1; return acc; }, {});
  const icon = decision === 'APPROVE' ? '✅' : '🔴';
  const lines = [
    `${icon} **AI Code Review — ${decision}**`,
    '',
    summary,
    '',
    `| شدت | تعداد |`,
    `|---|---|`,
    `| 🔴 High | ${counts.High || 0} |`,
    `| 🟠 Medium | ${counts.Medium || 0} |`,
    `| 🔵 Low | ${counts.Low || 0} |`,
    '',
  ];

  // Anything that didn't make it onto a line of the diff — no line number, the
  // inline post failed, or it fell past the inline cap — has to be here, or
  // the author never sees it.
  const notInline = findings.filter((f) => !f.postedInline);
  if (notInline.length) {
    lines.push('### یافته‌ها', '');
    for (const f of notInline) lines.push(renderFinding(f), '');
  }

  lines.push(
    '---',
    `<sub>${stats.files} فایل بررسی شد` +
      (stats.skipped ? ` · ${stats.skipped} فایل رد شد` : '') +
      (inlineCount ? ` · ${inlineCount} کامنت خطی` : '') +
      ` · مدل: ${model || '—'}` +
      (stats.promptTokens || stats.completionTokens ? ` · توکن: ${stats.promptTokens}+${stats.completionTokens}` : '') +
      ` · کامیت: ${String(headSha || '').slice(0, 8)}</sub>`,
    '',
    '<sub>این ریویو خودکار است و جای ریویوی انسانی را نمی‌گیرد.</sub>',
    marker('summary-' + String(headSha || '').slice(0, 12))
  );
  return lines.join('\n');
}

// GitLab rejects a discussion whose position isn't a real line of the diff, so
// the position is built from the parsed diff's own line map, never from what
// the model claimed alone.
function buildPosition({ finding, file, diffRefs }) {
  const entry = file.lineMap.get(finding.line);
  if (!entry) return null;
  const position = {
    position_type: 'text',
    base_sha: diffRefs.base_sha,
    start_sha: diffRefs.start_sha,
    head_sha: diffRefs.head_sha,
    new_path: file.path,
    old_path: file.oldPath || file.path,
  };
  if (entry.type === 'add') {
    position.new_line = finding.line;
  } else {
    // Context line: GitLab wants both sides.
    position.new_line = finding.line;
    position.old_line = entry.oldLine;
  }
  return position;
}

async function publish({ projectId, mrIid, result, files, diffRefs, headSha, model, inline = true }) {
  const posted = await existingMarkers(projectId, mrIid);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const outcome = { inline: 0, skippedDuplicate: 0, inlineFailed: 0, summaryPosted: false };

  if (inline && diffRefs) {
    const inlineFindings = result.findings.filter((f) => f.line && byPath.has(f.file)).slice(0, MAX_INLINE);
    for (const finding of inlineFindings) {
      const fp = fingerprint(finding);
      if (posted.has(fp)) {
        // Already said on an earlier round — the existing thread is still on
        // the MR, so repeating it in the summary would be noise too.
        outcome.skippedDuplicate++;
        finding.postedInline = true;
        continue;
      }
      const position = buildPosition({ finding, file: byPath.get(finding.file), diffRefs });
      if (!position) continue;
      const body = renderFinding(finding) + '\n\n' + marker(fp);
      try {
        await gitlab.createDiscussion(projectId, mrIid, body, position);
        outcome.inline++;
        posted.add(fp);
        finding.postedInline = true;
      } catch (e) {
        // A rejected position shouldn't lose the finding — it still reaches
        // the author through the summary comment below.
        console.error(`[publish] inline comment failed (${finding.file}:${finding.line}):`, e.message);
        outcome.inlineFailed++;
        finding.inlineFailed = true;
      }
    }
  }

  const summaryFp = 'summary-' + String(headSha || '').slice(0, 12);
  if (posted.has(summaryFp)) {
    outcome.summarySkipped = true;
    return outcome;
  }

  const body = buildSummary({
    decision: result.decision,
    summary: result.summary,
    findings: result.findings,
    stats: result.stats,
    inlineCount: outcome.inline,
    headSha,
    model,
  });
  await gitlab.postNote(projectId, mrIid, body);
  outcome.summaryPosted = true;
  return outcome;
}

module.exports = { publish, buildSummary, renderFinding, fingerprint, buildPosition, existingMarkers, MAX_INLINE };
