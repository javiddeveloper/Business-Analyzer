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
// a restart — "which sha did we already review" — lives in state.js instead.
const gitlab = require('./gitlab');
const reviewer = require('./reviewer');
const publisher = require('./publish');
const state = require('./state');
const { secret } = require('./ai_bridge');

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
    error: null,
    posted: false,
    approved: false,
    approveError: null,
    sha: null,
    filesReviewed: 0,
  };
  jobs.set(key, job);
  const controller = new AbortController();
  controllers.set(key, controller);

  (async () => {
    try {
      const detail = await gitlab.getMergeRequestChanges(projectId, mrIid);
      const changes = detail.changes || [];
      job.title = detail.title || job.title;
      job.webUrl = detail.web_url || job.webUrl;
      job.sha = (detail.diff_refs && detail.diff_refs.head_sha) || detail.sha || null;

      const result = await reviewer.review({
        mr: { title: detail.title, description: detail.description },
        changes,
        signal: controller.signal,
      });
      job.decision = result.decision;
      job.summary = result.summary;
      job.findings = result.findings;
      job.stats = result.stats;
      job.filesReviewed = result.stats.files;

      const { files } = reviewer.prepareFiles(changes);
      contexts.set(key, { files, diffRefs: detail.diff_refs });

      if (post) {
        job.publishResult = await publisher.publish({
          projectId,
          mrIid,
          result,
          files,
          diffRefs: detail.diff_refs,
          headSha: job.sha,
          model: secret('AI_MODEL') || '',
          inline: state.getSettings().inlineComments !== false,
        });
        job.posted = true;

        // Approve, never merge — merging stays a human call (see server.js's
        // routing comment). GitLab's approve endpoint is idempotent-ish: it
        // 404s if this token already approved, which isn't a real failure.
        if (result.decision === 'APPROVE' && state.getSettings().autoApprove) {
          try {
            await gitlab.approveMergeRequest(projectId, mrIid);
            job.approved = true;
          } catch (e) {
            job.approveError = e.message;
          }
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
    model: secret('AI_MODEL') || '',
    inline: state.getSettings().inlineComments !== false,
  });
  job.posted = true;

  if (job.decision === 'APPROVE' && state.getSettings().autoApprove) {
    try {
      await gitlab.approveMergeRequest(projectId, mrIid);
      job.approved = true;
    } catch (e) {
      job.approveError = e.message;
    }
  }
  return job;
}

module.exports = { start, stop, get, list, postExisting, keyFor };
