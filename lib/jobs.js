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
const state = require('./state');

const jobs = new Map();

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
    note: null,
    error: null,
    posted: false,
    sha: null,
    filesReviewed: 0,
  };
  jobs.set(key, job);

  (async () => {
    try {
      const detail = await gitlab.getMergeRequestChanges(projectId, mrIid);
      const changes = detail.changes || [];
      job.title = detail.title || job.title;
      job.webUrl = detail.web_url || job.webUrl;
      job.sha = (detail.diff_refs && detail.diff_refs.head_sha) || detail.sha || null;
      job.filesReviewed = changes.length;

      const result = await reviewer.review({
        mr: { title: detail.title, description: detail.description },
        changes,
      });
      job.note = result.note;
      job.decision = result.decision;

      if (post) {
        await gitlab.postNote(projectId, mrIid, result.note);
        job.posted = true;
      }
      // Only mark reviewed once the run actually succeeded — otherwise a
      // failed run would suppress the auto-review retry for those commits.
      state.markReviewed(key, job.sha);
      job.status = 'done';
    } catch (e) {
      job.status = 'error';
      job.error = e.message;
    } finally {
      job.finishedAt = Date.now();
    }
  })();

  return job;
}

// Publishes an already-computed review note (from the dashboard, when the run
// was made without auto-posting).
async function postExisting(projectId, mrIid) {
  const job = get(projectId, mrIid);
  if (!job || !job.note) throw new Error('no review result to post for this MR');
  await gitlab.postNote(projectId, mrIid, job.note);
  job.posted = true;
  return job;
}

module.exports = { start, get, list, postExisting, keyFor };
