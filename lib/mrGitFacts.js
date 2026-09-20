// Facts about a merge request that only the local checkout can answer.
//
// The report used to describe an MR with what GitLab's API hands over: a head
// sha and a file count. That leaves out the three things a reviewer states
// first — what this branch is measured *against*, how much is actually the
// author's own work, and whether it still merges. All three need git.
//
// Everything here is best-effort by design. A missing checkout, a target
// branch that was never fetched, a shallow clone: each returns null for its
// own field and never throws, because a report that is missing one row is
// worth more than a review that failed to write one.
const { execFile } = require('child_process');

const GIT_TIMEOUT_MS = 20000;
const MAX_BUFFER = 8 * 1024 * 1024;

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout).trim());
    });
  });
}

// The target branch as git can actually name it here. A review runs against a
// checkout that may or may not have a local branch for the target, so the
// remote-tracking ref is tried first — it is the one that exists on a machine
// that only ever fetches.
async function resolveTarget(cwd, targetBranch) {
  if (!targetBranch) return null;
  for (const ref of [`origin/${targetBranch}`, targetBranch]) {
    if (await git(cwd, ['rev-parse', '--verify', '--quiet', ref])) return ref;
  }
  return null;
}

// Where this branch left the target. Every other number here is measured from
// this commit, not from the target's tip: diffing against the tip would count
// everything that landed on develop since the branch started as though the
// author had written it.
async function mergeBase(cwd, targetRef, headSha) {
  if (!targetRef || !headSha) return null;
  return git(cwd, ['merge-base', targetRef, headSha]);
}

// Files changed and lines added/removed between the merge-base and the head —
// the author's own work, with merges from the target excluded by construction.
async function ownDiffSize(cwd, base, headSha) {
  if (!base || !headSha) return null;
  const out = await git(cwd, ['diff', '--shortstat', `${base}..${headSha}`]);
  if (out == null) return null;
  const files = /(\d+) files? changed/.exec(out);
  const ins = /(\d+) insertions?\(\+\)/.exec(out);
  const del = /(\d+) deletions?\(-\)/.exec(out);
  return {
    files: files ? Number(files[1]) : 0,
    insertions: ins ? Number(ins[1]) : 0,
    deletions: del ? Number(del[1]) : 0,
  };
}

// How far the branch has drifted. `behind` is what makes a review stale: a
// clean review of a branch 59 commits behind its target has not seen what it
// will actually merge into.
async function divergence(cwd, targetRef, headSha) {
  if (!targetRef || !headSha) return null;
  const out = await git(cwd, ['rev-list', '--left-right', '--count', `${targetRef}...${headSha}`]);
  if (!out) return null;
  const [behind, ahead] = out.split(/\s+/).map(Number);
  return { behind: behind || 0, ahead: ahead || 0 };
}

// Would it merge? Answered with merge-tree, which computes the merge in memory
// and touches neither the index nor the working tree — the checkout a review
// runs against is the user's own, and a trial `git merge` in it would be an
// unacceptable side effect.
//
// merge-tree's --write-tree form exits non-zero on conflict, which is exactly
// the signal wanted; older gits lack it, and there `null` is returned rather
// than guessing from the legacy output format.
async function trialMerge(cwd, targetRef, headSha) {
  if (!targetRef || !headSha) return null;
  const supported = await git(cwd, ['merge-tree', '--write-tree', '-h']);
  const probe = await new Promise((resolve) => {
    execFile('git', ['merge-tree', '--write-tree', '--name-only', targetRef, headSha],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      (err, stdout) => {
        if (!err) return resolve({ clean: true, conflicts: [] });
        // Exit 1 means conflicts, and stdout then carries the tree oid on the
        // first line followed by the conflicted paths. Any other failure
        // (unknown flag on an old git) is reported as "unknown".
        if (err.code === 1) {
          // stdout is: <tree oid>, then one line per conflicted path, then a
          // blank line, then git's own "Auto-merging" / "CONFLICT (content)"
          // chatter. Only the block before that blank line is data.
          const all = String(stdout).split('\n').map((l) => l.trimEnd());
          const blank = all.indexOf('', 1);
          const paths = all.slice(1, blank === -1 ? all.length : blank).filter(Boolean);
          return resolve({ clean: false, conflicts: paths });
        }
        resolve(null);
      });
  });
  if (probe === null && supported === null) return null;
  return probe;
}

// Everything the report needs, gathered in one pass. `headSha` is the commit
// the review actually read, so the facts describe that commit rather than
// whatever the working tree happens to be sitting on.
async function collect({ projectPath, targetBranch, headSha }) {
  const empty = { targetRef: null, base: null, size: null, divergence: null, merge: null };
  if (!projectPath || !headSha) return empty;

  const targetRef = await resolveTarget(projectPath, targetBranch);
  if (!targetRef) return { ...empty, headSha };

  const base = await mergeBase(projectPath, targetRef, headSha);
  const [size, div, merge] = await Promise.all([
    ownDiffSize(projectPath, base, headSha),
    divergence(projectPath, targetRef, headSha),
    trialMerge(projectPath, targetRef, headSha),
  ]);
  return { targetRef, base, size, divergence: div, merge, headSha };
}

module.exports = { collect, resolveTarget, mergeBase, ownDiffSize, divergence, trialMerge };
