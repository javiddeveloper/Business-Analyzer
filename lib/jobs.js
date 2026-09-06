// In-memory registry of review runs, one entry per merge request.
//
// Concurrency model: different MRs review in parallel (each run is just an
// async function — nothing is shared between them), but the same MR never
// has two runs in flight at once. Without that guard, a webhook firing while
// the dashboard's manual run is still going would post two comments for the
// same commits.
//
// Deliberately in-memory: a job is live UI state (running/done/error + the
// resulting note), meaningful only while the server is up. What must survive
// a restart — "which sha did we already review", "which MR did we already
// approve" — lives in state.js instead.
const gitlab = require('./gitlab');
const reviewer = require('./reviewer');
const publisher = require('./publish');
const localRepo = require('./localRepo');
const reportFile = require('./reportFile');
const activity = require('./activity');
const state = require('./state');
const { secret, engineStatus } = require('./ai_bridge');

// The model label shown in the GitLab comment footer / dashboard — resolved
// through the *active engine's own* model key (engineStatus), not a shared
// AI_MODEL field: Claude CLI/Gemini/9Router each keep their model name under
// a different secrets.env key, so reading AI_MODEL directly would report the
// GapGPT engine's model even when a different engine actually ran the review.
function activeModelLabel() {
  return engineStatus((secret('AI_PROVIDER') || 'openai-compatible').toLowerCase()).model || '';
}

const jobs = new Map();
// Parsed diff + diff_refs per job, kept out of the job object itself so
// /api/jobs stays a small JSON payload the dashboard can poll every few
// seconds. Needed later only if the user posts a run they held back.
const contexts = new Map();
// AbortControllers, kept separate from the job object for the same reason —
// an AbortController/AbortSignal doesn't survive JSON.stringify cleanly and
// has no business being in an API response anyway.
const controllers = new Map();

function keyFor(projectId, mrIid) {
  return `${projectId}!${mrIid}`;
}

function get(projectId, mrIid) {
  return jobs.get(keyFor(projectId, mrIid)) || null;
}

function list() {
  return Array.from(jobs.values());
}

function projectPathConfigured() {
  return !!secret('PROJECT_PATH');
}

// The team merges MRs in creation order — listOpenMergeRequests() already
// returns them oldest-first for exactly this reason. Before approving a
// later MR, every still-open MR created earlier in the same project must
// already be approved by this bot, or the approval would say "safe to merge
// now" about something that would jump the queue.
async function mergeOrderBlockers(projectId, createdAt) {
  const all = await gitlab.listOpenMergeRequests();
  const earlier = (Array.isArray(all) ? all : []).filter(
    (m) => m.project_id === projectId && new Date(m.created_at).getTime() < new Date(createdAt).getTime()
  );
  return earlier.filter((m) => !state.isApproved(keyFor(m.project_id, m.iid)));
}

async function tryApprove({ projectId, mrIid, job, createdAt }) {
  const key = keyFor(projectId, mrIid);
  try {
    const blockers = await mergeOrderBlockers(projectId, createdAt);
    if (blockers.length) {
      job.approveError = 'در انتظار ترتیب merge — این MRها زودتر ساخته شده‌اند و هنوز approve نشده‌اند: ' +
        blockers.map((b) => `!${b.iid}`).join('، ');
      return;
    }
  } catch (e) {
    job.approveError = 'بررسی ترتیب merge با خطا مواجه شد: ' + e.message;
    return;
  }
  try {
    await gitlab.approveMergeRequest(projectId, mrIid);
    job.approved = true;
    state.markApproved(key);
  } catch (e) {
    job.approveError = e.message;
  }
}

// mr: optional metadata already known by the caller (webhook payload / MR list),
// used only to label the job before the diff fetch returns.
// post: whether to publish the review as a comment on the MR.
// trigger: 'manual' | 'auto' | 'webhook' — shown in the dashboard.
function start({ projectId, mrIid, mr, post = true, trigger = 'manual' }) {
  const key = keyFor(projectId, mrIid);
  const existing = jobs.get(key);
  if (existing && existing.status === 'running') return existing;

  const job = {
    key,
    projectId,
    mrIid,
    title: (mr && mr.title) || (existing && existing.title) || '',
    webUrl: (mr && mr.web_url) || (existing && existing.webUrl) || '',
    status: 'running',
    trigger,
    startedAt: Date.now(),
    finishedAt: null,
    decision: null,
    summary: null,
    findings: [],
    stats: null,
    publishResult: null,
    reportPath: null,
    reportError: null,
    error: null,
    posted: false,
    approved: false,
    approveError: null,
    sha: null,
    filesReviewed: 0,
  };
  jobs.set(key, job);

  // Reviewing without the local project checked out means reviewing a bare
  // diff with no surrounding file, and nowhere to write review/MR-<iid>.md —
  // this product's whole point now includes both, so it refuses rather than
  // silently doing a lesser review.
  if (!projectPathConfigured()) {
    job.status = 'error';
    job.error = 'مسیر پروژه‌ی محلی تنظیم نشده. از دکمه‌ی ⚙ تنظیمات در بالای صفحه، PROJECT_PATH را وارد کن.';
    job.finishedAt = Date.now();
    return job;
  }

  const controller = new AbortController();
  controllers.set(key, controller);

  (async () => {
    try {
      const detail = await gitlab.getMergeRequestChanges(projectId, mrIid);
      const changes = detail.changes || [];
      job.title = detail.title || job.title;
      job.webUrl = detail.web_url || job.webUrl;
      job.sha = (detail.diff_refs && detail.diff_refs.head_sha) || detail.sha || null;
      job.createdAt = detail.created_at || null;

      const local = await localRepo.loadContext({
        projectPath: secret('PROJECT_PATH'),
        mrIid,
        baseSha: detail.diff_refs && detail.diff_refs.base_sha,
        headSha: detail.diff_refs && detail.diff_refs.head_sha,
        paths: changes.map((c) => c.new_path || c.old_path),
      });

      const result = await reviewer.review({
        mr: { title: detail.title, description: detail.description },
        changes,
        fileContents: local.fileContents,
        signal: controller.signal,
      });
      if (local.warning) {
        result.findings = reviewer.sortFindings([
          ...result.findings,
          { file: null, line: null, severity: 'Low', category: 'process', source: 'auto', title: 'دسترسی به مسیر لوکال ناموفق بود', note: local.warning },
        ]);
      }
      job.decision = result.decision;
      job.summary = result.summary;
      job.findings = result.findings;
      job.stats = result.stats;
      job.filesReviewed = result.stats.files;
      job.author = detail.author;

      const severityCounts = result.findings.reduce((acc, f) => { acc[f.severity] = (acc[f.severity] || 0) + 1; return acc; }, {});
      activity.recordReview({ author: detail.author, projectId, mrIid, decision: result.decision, severityCounts, filesReviewed: result.stats.files });

      const { files } = reviewer.prepareFiles(changes);
      contexts.set(key, { files, diffRefs: detail.diff_refs });

      const written = reportFile.writeReport({
        projectPath: secret('PROJECT_PATH'),
        mrIid,
        mr: detail,
        result,
      });
      job.reportPath = written.path;
      job.reportError = written.error || null;

      if (post) {
        job.publishResult = await publisher.publish({
          projectId,
          mrIid,
          result,
          files,
          diffRefs: detail.diff_refs,
          headSha: job.sha,
          model: activeModelLabel(),
          inline: state.getSettings().inlineComments !== false,
        });
        job.posted = true;

        // Approve, never merge — merging stays a human call (see server.js's
        // routing comment).
        if (result.decision === 'APPROVE' && state.getSettings().autoApprove) {
          await tryApprove({ projectId, mrIid, job, createdAt: job.createdAt });
        }
      }
      // Only mark reviewed once the run actually succeeded — otherwise a
      // failed run would suppress the auto-review retry for those commits.
      state.markReviewed(key, job.sha);
      job.status = 'done';
    } catch (e) {
      job.status = e.name === 'AbortError' ? 'stopped' : 'error';
      if (job.status === 'error') job.error = e.message;
    } finally {
      job.finishedAt = Date.now();
      controllers.delete(key);
    }
  })();

  return job;
}

// Signals cancellation; the running batch calls notice on their next retry or
// response and unwind on their own (see ai_bridge's AbortError fast-path).
// Returns false when there was nothing running to stop.
function stop(projectId, mrIid) {
  const key = keyFor(projectId, mrIid);
  const controller = controllers.get(key);
  const job = jobs.get(key);
  if (!controller || !job || job.status !== 'running') return false;
  controller.abort();
  return true;
}

// Publishes an already-computed review (dashboard flow: run without posting,
// look at it, then decide to send it).
async function postExisting(projectId, mrIid) {
  const job = get(projectId, mrIid);
  const ctx = contexts.get(keyFor(projectId, mrIid));
  if (!job || !ctx) throw new Error('no review result to post for this MR');
  job.publishResult = await publisher.publish({
    projectId,
    mrIid,
    result: { decision: job.decision, summary: job.summary, findings: job.findings, stats: job.stats },
    files: ctx.files,
    diffRefs: ctx.diffRefs,
    headSha: job.sha,
    model: activeModelLabel(),
    inline: state.getSettings().inlineComments !== false,
  });
  job.posted = true;

  if (job.decision === 'APPROVE' && state.getSettings().autoApprove) {
    await tryApprove({ projectId, mrIid, job, createdAt: job.createdAt });
  }
  return job;
}

module.exports = { start, stop, get, list, postExisting, keyFor, projectPathConfigured, mergeOrderBlockers };
