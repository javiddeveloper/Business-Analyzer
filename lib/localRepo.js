// Pulls extra context for a review out of the team's own local checkout of
// the project (PROJECT_PATH), instead of relying only on GitLab's diff API.
//
// What this deliberately does NOT do: check out the MR, touch the working
// tree, or move any branch the user might have checked out. Every operation
// below is git plumbing against a namespaced ref (refs/coder-review/mr-<iid>)
// and exact commit SHAs — the equivalent of the team's own documented review
// process ("do not disturb the working tree"), just without even needing a
// worktree, since `git show <sha>:<path>` reads a file out of a commit
// without checking anything out.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const GIT_TIMEOUT_MS = 20000;
const MAX_BUFFER = 20 * 1024 * 1024;

function run(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

function isGitRepo(projectPath) {
  try {
    return fs.existsSync(path.join(projectPath, '.git'));
  } catch (e) {
    return false;
  }
}

// Brings the MR's source commits into the local repo under a ref namespace
// that can't collide with the user's own branches, without touching HEAD.
async function fetchMergeRequestRef(projectPath, mrIid) {
  const ref = `refs/coder-review/mr-${mrIid}`;
  await run(projectPath, ['fetch', 'origin', `+refs/merge-requests/${mrIid}/head:${ref}`, '--force']);
  return ref;
}

// A throwaway checkout of the MR's head, for the agent-mode review that
// needs to *browse* the project (read neighbouring files, grep for callers)
// rather than just read the diff. A git worktree is the same tool the team's
// own manual process uses for exactly this reason: the main checkout — with
// whatever branch and uncommitted work the user has open — is never touched.
//
// Detached HEAD on purpose: no branch is created, so nothing here can ever be
// mistaken for (or pushed as) real work.
function worktreeDir(projectPath, mrIid) {
  return path.join(path.dirname(projectPath), '.coder-review-worktrees', `mr-${mrIid}`);
}

async function ensureWorktree({ projectPath, mrIid, headSha }) {
  const dir = worktreeDir(projectPath, mrIid);

  // The commit has to exist locally before anything can be checked out at it.
  // Prefer the MR ref (works even when the source branch is long gone), and
  // fall back to fetching the bare sha — GitLab serves that when the server
  // allows reachable-SHA fetches, which covers the case where the MR ref was
  // pruned (closed MRs on some instances) but the commit is still reachable.
  try { await fetchMergeRequestRef(projectPath, mrIid); } catch (e) {}
  try {
    await run(projectPath, ['cat-file', '-e', `${headSha}^{commit}`]);
  } catch (e) {
    await run(projectPath, ['fetch', 'origin', headSha]);
  }

  if (fs.existsSync(path.join(dir, '.git'))) {
    // Reuse: just move the existing checkout to this MR's current head, so a
    // re-review after new commits doesn't pay for a fresh full checkout.
    try {
      await run(dir, ['checkout', '--detach', '--force', headSha]);
      await run(dir, ['clean', '-fd']);
      return dir;
    } catch (e) {
      // Corrupt/stale worktree — drop it and fall through to a fresh one.
      try { await run(projectPath, ['worktree', 'remove', '--force', dir]); } catch (e2) {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e2) {}
    }
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  // `git worktree add` refuses if the path exists but isn't a worktree, and
  // prune clears entries left behind by a directory someone deleted by hand.
  try { await run(projectPath, ['worktree', 'prune']); } catch (e) {}
  await run(projectPath, ['worktree', 'add', '--detach', '--force', dir, headSha]);
  return dir;
}

async function removeWorktree({ projectPath, mrIid }) {
  const dir = worktreeDir(projectPath, mrIid);
  try { await run(projectPath, ['worktree', 'remove', '--force', dir]); } catch (e) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}

async function readFileAt(projectPath, sha, filePath) {
  try {
    // git uses forward slashes even on Windows for tree paths.
    const gitPath = filePath.replace(/\\/g, '/');
    return await run(projectPath, ['show', `${sha}:${gitPath}`]);
  } catch (e) {
    return null; // deleted, renamed away, binary (git show still returns text for those, but a missing path is the common case), or otherwise unavailable
  }
}

// Returns { fileContents: {path: content}, warning: string|null }. Never
// throws — a problem here degrades the review (less context) rather than
// failing it outright, since the GitLab-API diff alone is still a valid,
// honest review.
async function loadContext({ projectPath, mrIid, headSha, paths }) {
  if (!projectPath) return { fileContents: {}, warning: 'PROJECT_PATH تنظیم نشده.' };
  if (!fs.existsSync(projectPath)) {
    return { fileContents: {}, warning: `مسیر '${projectPath}' پیدا نشد — تنظیمات را چک کن.` };
  }
  if (!isGitRepo(projectPath)) {
    return { fileContents: {}, warning: `مسیر '${projectPath}' یک ریپازیتوری گیت نیست (پوشه‌ی .git ندارد).` };
  }

  try {
    await fetchMergeRequestRef(projectPath, mrIid);
  } catch (e) {
    return { fileContents: {}, warning: `دریافت MR !${mrIid} از ریپازیتوری محلی ناموفق بود: ${(e.stderr || e.message || '').toString().trim().slice(0, 300)}` };
  }

  const uniquePaths = Array.from(new Set((paths || []).filter(Boolean)));
  const fileContents = {};
  await Promise.all(
    uniquePaths.map(async (p) => {
      const content = await readFileAt(projectPath, headSha, p);
      if (content != null) fileContents[p] = content;
    })
  );
  return { fileContents, warning: null };
}

module.exports = { loadContext, isGitRepo, fetchMergeRequestRef, readFileAt, ensureWorktree, removeWorktree, worktreeDir };
