// Zero-dependency HTTP server — same "no framework, no database" approach as
// business-generator-light: plain `http`, file-based knowledge base, no build
// step for the admin UI.
const http = require('http');
const fs = require('fs');
const path = require('path');

const gitlab = require('./lib/gitlab');
const reviewer = require('./lib/reviewer');
const knowledge = require('./lib/knowledge');
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

// Same network-guard idea as business-generator: local access needs no
// token by default; anything else must present ADMIN_TOKEN. This only
// gates the knowledge-base admin API — the GitLab webhook has its own
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

async function handleWebhook(req, res) {
  const headerToken = req.headers['x-gitlab-token'];
  if (!gitlab.verifyWebhookToken(headerToken)) {
    return sendJson(res, 401, { error: 'invalid or missing X-Gitlab-Token' });
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (e) {
    return sendJson(res, 400, { error: 'invalid JSON body' });
  }

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

  // Acknowledge immediately — GitLab's webhook timeout is short and an LLM
  // call plus a GitLab API round-trip can easily exceed it. Review runs after
  // the response is sent; failures are reported back as a note on the MR.
  sendJson(res, 200, { accepted: true, project: projectId, mr: mrIid });

  (async () => {
    try {
      const changes = await gitlab.getMergeRequestChanges(projectId, mrIid);
      const { note } = await reviewer.review({ mr: attrs, changes: changes.changes || [] });
      await gitlab.postNote(projectId, mrIid, note);
      console.log(`[review] posted note on project ${projectId} MR !${mrIid}`);
    } catch (e) {
      console.error(`[review] failed for project ${projectId} MR !${mrIid}:`, e.message);
      try {
        await gitlab.postNote(projectId, mrIid, `🤖 **AI Code Review** — خطای داخلی هنگام ریویو: ${e.message}`);
      } catch (e2) {
        console.error('[review] could not even post the error note:', e2.message);
      }
    }
  })();
}

async function handleKnowledgeCollection(req, res) {
  if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'unauthorized' });
  if (req.method === 'GET') return sendJson(res, 200, knowledge.list());
  if (req.method === 'POST') {
    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch (e) {
      return sendJson(res, 400, { error: 'invalid JSON body' });
    }
    if (body.fileBase64) {
      const content = await knowledge.extractText(body.ext, body.fileBase64);
      return sendJson(res, 200, knowledge.write({ title: body.title, content, source: 'upload' }));
    }
    if (!body.content) return sendJson(res, 400, { error: 'content is required' });
    return sendJson(res, 200, knowledge.write({ title: body.title, content: body.content, source: 'written' }));
  }
  return sendJson(res, 405, { error: 'method not allowed' });
}

async function handleKnowledgeItem(req, res, id) {
  if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'unauthorized' });
  if (req.method === 'GET') return sendJson(res, 200, { id, content: knowledge.read(id) });
  if (req.method === 'DELETE') return sendJson(res, 200, { ok: knowledge.remove(id) });
  return sendJson(res, 405, { error: 'method not allowed' });
}

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
    if (pathname === '/api/knowledge') {
      return await handleKnowledgeCollection(req, res);
    }
    const kbItemMatch = pathname.match(/^\/api\/knowledge\/([\w-]+)$/);
    if (kbItemMatch) {
      return await handleKnowledgeItem(req, res, kbItemMatch[1]);
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
  console.log(`  پنل پایگاه دانش: http://localhost:${PORT}/admin`);
});
