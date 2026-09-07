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
const envFile = require('./lib/envFile');
const activity = require('./lib/activity');
const ratings = require('./lib/ratings');
const task = require('./lib/task');
const devAnalytics = require('./lib/devAnalytics');
const { secret, listModels, listEngines, engineStatus, testEngine, ENGINES } = require('./lib/ai_bridge');

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

  // Logged regardless of whether a review actually runs below — this is the
  // "which branch/task is this developer on right now, and since when" trail
  // the Developers tab is built from, independent of PROJECT_PATH being set.
  activity.recordEvent({
    author: payload.user || attrs.author,
    projectId, mrIid,
    branch: attrs.source_branch,
    targetBranch: attrs.target_branch,
    task: task.extractTask(attrs.source_branch) || task.extractTask(attrs.title),
    action, sha: attrs.last_commit && attrs.last_commit.id,
    title: attrs.title, webUrl: attrs.url,
  });

  if (!jobs.projectPathConfigured()) {
    return sendJson(res, 200, { skipped: 'PROJECT_PATH is not configured — set it from the dashboard settings before reviews can run' });
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
  // Same source of truth as the toolbar's engine picker, so the header badge
  // and that list can never disagree about whether an engine is configured.
  const status = engineStatus(provider);
  const ai = {
    provider,
    model: status.model || '(پیش‌فرض CLI)',
    state: status.state,
  };
  const projectPath = secret('PROJECT_PATH');
  const out = {
    ai,
    settings,
    gitlab: { url: gitlab.gitlabBase(), ok: false, user: null, name: null, bot: false, error: null },
    projectPath: { set: !!projectPath, value: projectPath || '' },
  };
  if (!secret('GITLAB_TOKEN')) {
    out.gitlab.error = 'GITLAB_TOKEN تنظیم نشده است.';
    return sendJson(res, 200, out);
  }
  try {
    const user = await gitlab.getCurrentUser();
    out.gitlab.ok = true;
    // Both, not one: a Project/Group Access Token's username is an unreadable
    // `project_<id>_bot_<hash>`, while its display name is what the human
    // actually typed when creating it. The badge shows the name; the exact
    // username stays available for the tooltip, since that's the identity
    // every comment and approval on GitLab is attributed to.
    out.gitlab.user = user.username || null;
    out.gitlab.name = user.name || null;
    out.gitlab.bot = !!user.bot;
  } catch (e) {
    out.gitlab.error = e.message;
  }
  return sendJson(res, 200, out);
}

// Shared by /api/merge-requests and /api/developers so both agree on merge
// order and task/branch derivation — gitlab.listOpenMergeRequests() already
// orders oldest-created-first (the intended merge order), so array position
// doubles as the number the dashboard shows on each tab/card.
async function loadMappedMergeRequests() {
  const mrs = await gitlab.listOpenMergeRequests();
  return (Array.isArray(mrs) ? mrs : []).map((mr, i) => ({
    projectId: mr.project_id,
    iid: mr.iid,
    title: mr.title,
    author: (mr.author && (mr.author.name || mr.author.username)) || '',
    authorKey: activity.authorKey(mr.author),
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch,
    targetIsDevelop: mr.target_branch === 'develop',
    task: task.extractTask(mr.source_branch) || task.extractTask(mr.title),
    webUrl: mr.web_url,
    sha: mr.sha,
    createdAt: mr.created_at,
    updatedAt: mr.updated_at,
    draft: !!(mr.draft || mr.work_in_progress),
    mergeOrder: i + 1,
    approved: state.isApproved(jobs.keyFor(mr.project_id, mr.iid)),
    lastReviewedSha: state.lastReviewedSha(jobs.keyFor(mr.project_id, mr.iid)),
  }));
}

async function handleMergeRequests(req, res) {
  try {
    return sendJson(res, 200, await loadMappedMergeRequests());
  } catch (e) {
    return sendJson(res, 502, { error: e.message });
  }
}

// One card per developer with an open MR: what they're on right now (from
// GitLab's own MR list), plus the automatic activity/accuracy score and any
// manual rating on file. A developer with zero open MRs simply doesn't
// appear — there is nothing honest to say about someone with no current work.
async function handleDevelopers(req, res) {
  let mrs;
  try {
    mrs = await loadMappedMergeRequests();
  } catch (e) {
    return sendJson(res, 502, { error: e.message });
  }
  const byAuthor = new Map();
  for (const mr of mrs) {
    if (!mr.authorKey) continue;
    if (!byAuthor.has(mr.authorKey)) byAuthor.set(mr.authorKey, { author: mr.authorKey, displayName: mr.author, currentWork: [] });
    byAuthor.get(mr.authorKey).currentWork.push({
      projectId: mr.projectId, iid: mr.iid, title: mr.title,
      sourceBranch: mr.sourceBranch, targetBranch: mr.targetBranch, targetIsDevelop: mr.targetIsDevelop,
      task: mr.task, mergeOrder: mr.mergeOrder, updatedAt: mr.updatedAt, webUrl: mr.webUrl, draft: mr.draft,
    });
  }
  const developers = Array.from(byAuthor.values()).map((dev) => ({
    ...dev,
    auto: activity.computeAutoScore(dev.author),
    rating: ratings.get(dev.author),
    ratingOverall: ratings.overall(ratings.get(dev.author)),
  }));
  developers.sort((a, b) => (a.currentWork[0]?.mergeOrder || 99) - (b.currentWork[0]?.mergeOrder || 99));
  return sendJson(res, 200, { developers, ratingParams: ratings.PARAMS });
}

// Standalone from handleDevelopers (which only covers people with an open
// MR right now) — the analytics page can select anyone in the full roster,
// including someone with nothing open at the moment.
async function handleDeveloperScore(req, res, author) {
  return sendJson(res, 200, {
    auto: activity.computeAutoScore(author),
    rating: ratings.get(author),
    ratingOverall: ratings.overall(ratings.get(author)),
    ratingParams: ratings.PARAMS,
  });
}

async function handleDeveloperRating(req, res, author) {
  if (req.method === 'GET') return sendJson(res, 200, ratings.get(author));
  const body = await readJsonBody(req);
  if (!body) return sendJson(res, 400, { error: 'invalid JSON body' });
  return sendJson(res, 200, ratings.set(author, body.scores || {}, body.note));
}

// Roster for the Developer Analytics page's right-hand list — everyone who
// has ever opened an MR (from GitLab's own history), not just people with
// something open right now like handleDevelopers above.
async function handleDeveloperRoster(req, res) {
  try {
    const authors = await gitlab.listAllAuthors();
    return sendJson(res, 200, { authors });
  } catch (e) {
    return sendJson(res, 502, { error: e.message });
  }
}

// The analytics page itself: total MR history, the "round trip" signal
// (>1 person committed to the branch), grouped by month — see
// lib/devAnalytics.js for how each is computed. ?since=&until= (YYYY-MM-DD)
// scope it to a date range; omitted means all-time.
async function handleDeveloperAnalytics(req, res, author, query) {
  try {
    const data = await devAnalytics.buildDeveloperAnalytics(author, {
      since: query.get('since') || undefined,
      until: query.get('until') || undefined,
    });
    return sendJson(res, 200, data);
  } catch (e) {
    return sendJson(res, 502, { error: e.message });
  }
}

async function handleModels(req, res) {
  try {
    return sendJson(res, 200, await listModels());
  } catch (e) {
    return sendJson(res, 502, { error: e.message });
  }
}

// Toolbar engine picker (Claude / openai-compatible / 9Router / Gemini): GET
// lists the catalog with each engine's readiness (key set?) so the picker can
// flag one that still needs a key; POST just flips AI_PROVIDER — every
// engine's own key/base/model already lives in secrets.env under its own
// keys (see HTTP_ENGINES in ai_bridge.js), so switching never overwrites
// another engine's config the way retyping a shared AI_API_KEY field would.
// Validated against ai_bridge's own ENGINES catalog (not a hand-copied list)
// so a newly-added engine there is never listed-but-unselectable here.
const ENGINE_IDS = ENGINES.map((e) => e.id);

async function handleEngines(req, res) {
  if (req.method === 'GET') return sendJson(res, 200, { engines: listEngines() });
  const body = await readJsonBody(req);
  const id = body && body.id;
  if (!id || !ENGINE_IDS.includes(id)) {
    return sendJson(res, 400, { error: 'شناسه‌ی موتور نامعتبر است.' });
  }
  envFile.writeValues({ AI_PROVIDER: id });
  return sendJson(res, 200, { engines: listEngines() });
}

// "تست اتصال" button: fires one small real call at the requested engine
// (independent of which one is currently active) and reports success/latency
// or the exact error — e.g. a Claude subscription's session-limit message —
// without spending a full MR review just to find out if an engine works.
async function handleEngineTest(req, res) {
  const body = await readJsonBody(req);
  const id = body && body.id;
  if (!id || !ENGINE_IDS.includes(id)) {
    return sendJson(res, 400, { error: 'شناسه‌ی موتور نامعتبر است.' });
  }
  return sendJson(res, 200, await testEngine(id));
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

// Settings toolbar: read/write the values that used to require hand-editing
// secrets.env. GET returns secrets masked (see envFile.describe); POST only
// overwrites keys whose value actually changed — the frontend never re-sends
// a field the user didn't touch, so a masked placeholder can't clobber the
// real secret.
async function handleEnvSettings(req, res) {
  if (req.method === 'GET') return sendJson(res, 200, envFile.describe());
  const body = await readJsonBody(req);
  if (!body || typeof body.values !== 'object' || !body.values) {
    return sendJson(res, 400, { error: 'values object is required' });
  }
  const { written } = envFile.writeValues(body.values);
  return sendJson(res, 200, { written, values: envFile.describe() });
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
  if (!jobs.projectPathConfigured()) {
    console.error('[auto] PROJECT_PATH تنظیم نشده — از تنظیمات (⚙) در داشبورد وارد کن. ریویوی خودکار این دور را رد کرد.');
    return;
  }
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
    const url = new URL(req.url, 'http://internal');
    const pathname = url.pathname;

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
      if (req.method === 'GET' && pathname === '/api/developers') return await handleDevelopers(req, res);
      if (req.method === 'GET' && pathname === '/api/developers/roster') return await handleDeveloperRoster(req, res);
      if (req.method === 'GET' && pathname === '/api/models') return await handleModels(req, res);
      if (pathname === '/api/engines') return await handleEngines(req, res);
      if (req.method === 'POST' && pathname === '/api/engines/test') return await handleEngineTest(req, res);
      const analyticsMatch = pathname.match(/^\/api\/developers\/([^/]+)\/analytics$/);
      if (analyticsMatch) return await handleDeveloperAnalytics(req, res, decodeURIComponent(analyticsMatch[1]), url.searchParams);
      const ratingMatch = pathname.match(/^\/api\/developers\/([^/]+)\/rating$/);
      if (ratingMatch) return await handleDeveloperRating(req, res, decodeURIComponent(ratingMatch[1]));
      const scoreMatch = pathname.match(/^\/api\/developers\/([^/]+)\/score$/);
      if (scoreMatch) return await handleDeveloperScore(req, res, decodeURIComponent(scoreMatch[1]));
      if (req.method === 'GET' && pathname === '/api/jobs') return sendJson(res, 200, jobs.list());
      if (req.method === 'POST' && pathname === '/api/review') return await handleStartReview(req, res);
      if (req.method === 'POST' && pathname === '/api/review/stop') return await handleStopReview(req, res);
      if (req.method === 'POST' && pathname === '/api/post-note') return await handlePostNote(req, res);
      if (pathname === '/api/settings') return await handleSettings(req, res);
      if (pathname === '/api/env') return await handleEnvSettings(req, res);
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
