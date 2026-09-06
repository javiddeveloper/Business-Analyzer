// Builds the review prompt (tech-lead checklist + knowledge base + diff),
// calls the AI bridge, and renders the result as a GitLab-note-ready
// markdown string.
const fs = require('fs');
const path = require('path');
const { callModel } = require('./ai_bridge');
const knowledge = require('./knowledge');

const ROLE_PATH = path.join(__dirname, '..', 'roles', 'tech-lead.md');
// Total diff budget per review call, mirrors knowledge.js's context-budget
// pattern — a huge MR shouldn't silently blow up cost/latency on every push.
const MAX_DIFF_CHARS = 12000;

function loadRole() {
  try { return fs.readFileSync(ROLE_PATH, 'utf8'); } catch (e) { return ''; }
}

function buildDiffBlock(changes) {
  let body = '';
  for (const c of changes) {
    if (!c.diff) continue;
    const tag = c.new_file ? ' (فایل جدید)' : c.deleted_file ? ' (حذف شده)' : c.renamed_file ? ' (تغییر نام)' : '';
    const header = `--- ${c.old_path} -> ${c.new_path}${tag}\n`;
    const chunk = header + c.diff + '\n\n';
    if (body.length + chunk.length > MAX_DIFF_CHARS) {
      body += '\n[... دیف طولانی‌تر از این بود؛ فقط بخشی از فایل‌های تغییریافته بررسی شد ...]\n';
      break;
    }
    body += chunk;
  }
  return body || '(دیف خالی است)';
}

function buildPrompt({ mr, changes }) {
  const role = loadRole();
  const kb = knowledge.contextBlock();
  const system = [role, kb].filter(Boolean).join('\n\n');
  const diffBlock = buildDiffBlock(changes);
  const user = [
    `عنوان Merge Request: ${mr.title || ''}`,
    mr.description ? `توضیحات: ${mr.description}` : '',
    '',
    'دیف زیر را طبق چک‌لیست بررسی کن.',
    'خروجی را دقیقاً به‌صورت یک JSON معتبر بده — بدون هیچ متن قبل یا بعدش:',
    '{"decision": "APPROVE" | "REQUEST_CHANGES", "summary": "خلاصه ۲ تا ۴ جمله‌ای", "findings": [{"file": "مسیر فایل", "note": "توضیح مشکل یا نکته"}]}',
    '',
    'دیف:',
    '```diff',
    diffBlock,
    '```',
  ].filter(Boolean).join('\n');
  return { system, user };
}

function parseModelJson(text) {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch (e) { return null; }
}

function renderNote(parsed, rawText) {
  if (!parsed || !parsed.decision) {
    return `🤖 **AI Code Review**\n\n(پاسخ مدل به فرمت JSON مورد انتظار نبود؛ متن خام مدل:)\n\n${String(rawText || '').slice(0, 3500)}`;
  }
  const icon = parsed.decision === 'APPROVE' ? '✅' : '🔴';
  const lines = [`${icon} **AI Code Review — ${parsed.decision}**`, '', parsed.summary || ''];
  if (Array.isArray(parsed.findings) && parsed.findings.length) {
    lines.push('', '**نکات:**');
    for (const f of parsed.findings) {
      lines.push(`- \`${f.file || '?'}\`: ${f.note || ''}`);
    }
  }
  return lines.join('\n');
}

async function review({ mr, changes }) {
  const { system, user } = buildPrompt({ mr, changes });
  const result = await callModel({ system, user, maxTokens: 2000 });
  if (result.error) {
    return { note: `🤖 **AI Code Review** — خطا در فراخوانی مدل هوش مصنوعی: ${result.error}`, decision: null };
  }
  const parsed = parseModelJson(result.text);
  return { note: renderNote(parsed, result.text), decision: parsed && parsed.decision };
}

module.exports = { review, buildPrompt };
