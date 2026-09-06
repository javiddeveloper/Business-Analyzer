// Zero-dependency HTTP server — same "no framework, no database" approach as
// business-generator-light: plain `http`, file-based storage, no build step
// for the dashboard.
const http = require('http');
const fs = require('fs');
const path = require('path');

const gitlab = require('./lib/gitlab');
const reviewer = require('./lib/reviewer');
const knowledge = require('./lib/knowledge');
const jobs = require('./lib/jobs');
const state = require('./lib/state');
const { secret } = require('./lib/ai_bridge');

const PORT = process.env.PORT || 8078;

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('payload too large'));
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  try {
    return JSON.parse((await readBody(req)) || '{}');
  } catch (e) {
    return null;
  }
}

// Same network-guard idea as business-generator: local access needs no token by
// default; anything else must present ADMIN_TOKEN. This gates the whole
// dashboard API (it can spend money and read GitLab) — the webhook has its own
// token check (verifyWebhookToken).
function isLocal(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}
function checkAdminAuth(req) {
  const adminToken = secret('ADMIN_TOKEN');
  if (!adminToken) return isLocal(req);
  return req.headers['x-admin-token'] === adminToken;
}

// ---- webhook --------------------------------------------------------------

async function handleWebhook(req, res) {
  const headerToken = req.headers['x-gitlab-token'];
  if (!gitlab.verifyWebhookToken(headerToken)) {
    return sendJson(res, 401, { error: 'invalid or missing X-Gitlab-Token' });
  }

  const payload = await readJsonBody(req);
  if (!payload) return sendJson(res, 400, { error: 'invalid JSON body' });

  if (payload.object_kind !== 'merge_request') {
    return sendJson(res, 200, { skipped: 'not a merge_request event' });
  }

  const attrs = payload.object_attributes || {};
  const action = attrs.action;
  const relevant = ['open', 'reopen', 'update'];
  // On 'update' only react when new commits actually landed (oldrev is set) —
  // otherwise every label/description/assignee edit would trigger a re-review.
  if (!relevant.includes(action) || (action === 'update' && !attrs.oldrev)) {
    return sendJson(res, 200, { skipped: `action=${action}, no new commits` });
  }

  const projectId = payload.project && payload.project.id;
  const mrIid = attrs.iid;
  if (!projectId || !mrIid) {
    return sendJson(res, 400, { error: 'missing project id or MR iid in payload' });
  }

  // Acknowledge immediately — GitLab's webhook timeout is short and an LLM call
  // plus a GitLab API round-trip can easily exceed it. The job runs in the
  // background and posts its own comment when done.
  jobs.start({ projectId, mrIid, mr: attrs, post: true, trigger: 'webhook' });
  return sendJson(res, 200, { accepted: true, project: projectId, mr: mrIid });
}

// ---- dashboard API --------------------------------------------------------

async function handleStatus(req, res) {
  const settings = state.getSettings();
  const provider = (secret('AI_PROVIDER') || 'openai-compatible').toLowerCase();
  const ai = {
    provider,
    model: secret('AI_MODEL') || (provider === 'gemini' ? 'gemini-2.0-flash' : 'gpt-4o-mini'),
    keySet: !!(provider === 'gemini' ? secret('GEMINI_API_KEY') : secret('AI_API_KEY')),
  };
  const out = { ai, settings, gitlab: { url: gitlab.gitlabBase(), ok: false, user: null, error: null } };
  if (!secret('GITLAB_TOKEN')) {
    out.gitlab.error = 'GITLAB_TOKEN تنظیم نشده است.';
    return sendJson(res, 200, out);
  }
  try {
    const user = await gitlab.getCurrentUser();
    out.gitlab.ok = true;
    out.gitlab.user = user.username || user.name || null;
  } catch (e) {
    out.gitlab.error = e.message;
  }
  return sendJson(res, 200, out);
}

async function handleMergeRequests(req, res) {
  try {
    const mrs = await gitlab.listOpenMergeRequests();
    const listed = (Array.isArray(mrs) ? mrs : []).map((mr) => ({
      projectId: mr.project_id,
      iid: mr.iid,
      title: mr.title,
      author: (mr.author && (mr.author.name || mr.author.username)) || '',
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      webUrl: mr.web_url,
      sha: mr.sha,
      updatedAt: mr.updated_at,
      draft: !!(mr.draft || mr.work_in_progress),
      lastReviewedSha: state.lastReviewedSha(jobs.keyFor(mr.project_id, mr.iid)),
    }));
    return sendJson(res, 200, listed);
  } catch (e) {
    return sendJson(res, 502, { error: e.message });
  }
}

async function handleStartReview(req, res) {
  const body = await readJsonBody(req);
  if (!body || !body.projectId || !body.iid) {
    return sendJson(res, 400, { error: 'projectId and iid are required' });
  }
  const job = jobs.start({
    projectId: body.projectId,
    mrIid: body.iid,
    mr: { title: body.title, web_url: body.webUrl },
    post: body.post !== false,
    trigger: 'manual',
  });
  return sendJson(res, 200, job);
}

async function handleStopReview(req, res) {
  const body = await readJsonBody(req);
  if (!body || !body.projectId || !body.iid) {
    return sendJson(res, 400, { error: 'projectId and iid are required' });
  }
  const stopped = jobs.stop(body.projectId, body.iid);
  return sendJson(res, 200, { stopped });
}

async function handlePostNote(req, res) {
  const body = await readJsonBody(req);
  if (!body || !body.projectId || !body.iid) {
    return sendJson(res, 400, { error: 'projectId and iid are required' });
  }
  try {
    const job = await jobs.postExisting(body.projectId, body.iid);
    return sendJson(res, 200, job);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
}

async function handleSettings(req, res) {
  if (req.method === 'GET') return sendJson(res, 200, state.getSettings());
  const body = await readJsonBody(req);
  if (!body) return sendJson(res, 400, { error: 'invalid JSON body' });
  const next = state.saveSettings(body);
  scheduleAutoTick();
  return sendJson(res, 200, next);
}

async function handleKnowledgeCollection(req, res) {
  if (req.method === 'GET') return sendJson(res, 200, knowledge.list());
  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!body) return sendJson(res, 400, { error: 'invalid JSON body' });
    if (body.fileBase64) {
      const content = await knowledge.extractText(body.ext, body.fileBase64);
      return sendJson(res, 200, knowledge.write({ title: body.title, content, source: 'upload' }));
    }
    if (!body.content) return sendJson(res, 400, { error: 'content is required' });
    // `id` present → edit in place instead of creating a second entry.
    return sendJson(res, 200, knowledge.write({ id: body.id, title: body.title, content: body.content, source: body.id ? 'written' : 'written' }));
  }
  return sendJson(res, 405, { error: 'method not allowed' });
}

async function handleKnowledgeItem(req, res, id) {
  if (req.method === 'GET') return sendJson(res, 200, { id, content: knowledge.read(id) });
  if (req.method === 'DELETE') return sendJson(res, 200, { ok: knowledge.remove(id) });
  return sendJson(res, 405, { error: 'method not allowed' });
}

// ---- auto-review poller ---------------------------------------------------
//
// The webhook path needs this server to be reachable *from* GitLab. Polling
// works the other way round, so auto-review also covers the common local /
// behind-NAT setup where no webhook can reach us at all.
let autoTimer = null;

async function autoTick() {
  const settings = state.getSettings();
  if (!settings.autoReview) return;
  try {
    const mrs = await gitlab.listOpenMergeRequests();
    for (const mr of Array.isArray(mrs) ? mrs : []) {
      const key = jobs.keyFor(mr.project_id, mr.iid);
      if (settings.skipDrafts && (mr.draft || mr.work_in_progress)) continue;
      // Nothing new since the last successful review of this MR.
      if (mr.sha && state.lastReviewedSha(key) === mr.sha) continue;
      const running = jobs.get(mr.project_id, mr.iid);
      if (running && running.status === 'running') continue;
      console.log(`[auto] reviewing !${mr.iid} (${mr.title})`);
      jobs.start({ projectId: mr.project_id, mrIid: mr.iid, mr, post: settings.autoPost, trigger: 'auto' });
    }
  } catch (e) {
    console.error('[auto] poll failed:', e.message);
  }
}

function scheduleAutoTick() {
  if (autoTimer) clearTimeout(autoTimer);
  const settings = state.getSettings();
  if (!settings.autoReview) return;
  autoTimer = setTimeout(async () => {
    await autoTick();
    scheduleAutoTick();
  }, settings.pollSeconds * 1000);
}

// ---- routing --------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://internal').pathname;

    if (req.method === 'POST' && pathname === '/webhook/gitlab') {
      return await handleWebhook(req, res);
    }
    if (req.method === 'GET' && pathname === '/health') {
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && (pathname === '/' || pathname === '/admin')) {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'admin.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (pathname.startsWith('/api/')) {
      if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'unauthorized' });

      if (req.method === 'GET' && pathname === '/api/status') return await handleStatus(req, res);
      if (req.method === 'GET' && pathname === '/api/merge-requests') return await handleMergeRequests(req, res);
      if (req.method === 'GET' && pathname === '/api/jobs') return sendJson(res, 200, jobs.list());
      if (req.method === 'POST' && pathname === '/api/review') return await handleStartReview(req, res);
      if (req.method === 'POST' && pathname === '/api/review/stop') return await handleStopReview(req, res);
      if (req.method === 'POST' && pathname === '/api/post-note') return await handlePostNote(req, res);
      if (pathname === '/api/settings') return await handleSettings(req, res);
      if (pathname === '/api/knowledge') return await handleKnowledgeCollection(req, res);
      const kbItemMatch = pathname.match(/^\/api\/knowledge\/([\w-]+)$/);
      if (kbItemMatch) return await handleKnowledgeItem(req, res, kbItemMatch[1]);
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[server] unhandled error:', e);
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`coder-review در حال اجرا: http://localhost:${PORT}`);
  console.log(`  وب‌هوک گیت‌لب: POST http://localhost:${PORT}/webhook/gitlab`);
  console.log(`  داشبورد: http://localhost:${PORT}/admin`);
  const settings = state.getSettings();
  if (settings.autoReview) {
    console.log(`  ریویوی خودکار: روشن (هر ${settings.pollSeconds} ثانیه)`);
    scheduleAutoTick();
  }
});
