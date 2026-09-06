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

module.exports = { loadContext, isGitRepo, fetchMergeRequestRef, readFileAt };
