// The whole-project (agent) review path: worktree creation against a real
// throwaway repo, prompt construction, and how the agent's output is turned
// into findings — including the case that only exists on this path, a finding
// about a line that isn't in the diff at all (a caller elsewhere in the repo).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

process.env.CR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-agent-'));

const agentReview = require('../lib/agentReview');
const localRepo = require('../lib/localRepo');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

const DIFF = [
  '@@ -1,4 +1,6 @@',
  ' class Repo {',
  '-    fun load(id: String) {}',
  '+    fun load(id: String?) {',
  '+        remote.fetch(id!!)',
  '+    }',
  ' }',
].join('\n');

function changes() {
  return [
    { old_path: 'app/Repo.kt', new_path: 'app/Repo.kt', diff: DIFF },
    { old_path: 'package-lock.json', new_path: 'package-lock.json', diff: '@@ -1 +1 @@\n+noise' },
  ];
}

test('prepareFilesFromChanges filters noise files and builds the diff line map', () => {
  const { files, skipped } = agentReview.prepareFilesFromChanges(changes());
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'app/Repo.kt');
  assert.equal(skipped.length, 1, 'the lockfile is skipped, not sent to the agent');
  assert.ok(files[0].lineMap.has(2), 'the added line is commentable');
});

test('the prompt tells the agent to explore the repo, not just read the diff', () => {
  const { files, skipped } = agentReview.prepareFilesFromChanges(changes());
  const prompt = agentReview.buildPrompt({
    mr: { title: 'Add null handling', description: 'desc', source_branch: 'feat', target_branch: 'develop' },
    files, skipped, diffText: DIFF,
  });
  assert.match(prompt, /Grep/, 'asks it to search for callers');
  assert.match(prompt, /app\/Repo\.kt \(\+3\/-1\)/, 'lists changed files with their stats');
  assert.match(prompt, /"findings"/, 'still pins the exact output schema the rest of the pipeline expects');
  assert.match(prompt, /Add null handling/);
});

test('a finding on a line outside the diff is kept, but not marked as diff-anchored', () => {
  const { files } = agentReview.prepareFilesFromChanges(changes());
  const out = agentReview.normalizeAgentFindings([
    { file: 'app/Repo.kt', line: 2, severity: 'High', title: 'on the diff', note: 'n' },
    // The point of agent mode: a real problem in a file this MR didn't touch.
    { file: 'app/Caller.kt', line: 87, severity: 'High', title: 'caller breaks', note: 'n' },
  ], files);

  assert.equal(out[0].line, 2);
  assert.equal(out[0].lineUnverified, false);

  assert.equal(out[1].file, 'app/Caller.kt', 'a finding outside the diff is not discarded');
  assert.equal(out[1].line, null, 'but it cannot be posted as an inline diff comment');
  assert.equal(out[1].claimedLine, 87, 'the line it named is preserved for the report');
  assert.ok(out[1].lineUnverified);
});

test('parseJson digs the object out even when the agent wraps it in prose', () => {
  assert.equal(agentReview.parseJson('Here you go:\n```json\n{"summary":"s","findings":[]}\n```')?.summary, 's');
  assert.equal(agentReview.parseJson('no json here'), null);
});

test('ensureWorktree checks the MR commit out without touching the main checkout', async (t) => {
  let hasGit = true;
  try { execFileSync('git', ['--version']); } catch (e) { hasGit = false; }
  if (!hasGit) return t.skip('git not available in this environment');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-wt-'));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  git(project, ['init']);
  git(project, ['config', 'user.email', 'a@b.c']);
  git(project, ['config', 'user.name', 'tester']);
  fs.writeFileSync(path.join(project, 'a.txt'), 'main-branch content\n');
  git(project, ['add', '.']);
  git(project, ['commit', '-m', 'base']);

  // A second commit on another branch stands in for the MR's head.
  git(project, ['checkout', '-b', 'mr-branch']);
  fs.writeFileSync(path.join(project, 'a.txt'), 'mr content\n');
  git(project, ['commit', '-am', 'mr change']);
  const headSha = git(project, ['rev-parse', 'HEAD']).trim();
  git(project, ['checkout', '-']);

  // ...and uncommitted work in the main checkout, which must survive untouched.
  fs.writeFileSync(path.join(project, 'scratch.txt'), 'do not lose me\n');

  const wt = await localRepo.ensureWorktree({ projectPath: project, mrIid: 42, headSha });
  const norm = (s) => s.replace(/\r\n/g, '\n');

  assert.equal(norm(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8')), 'mr content\n', 'worktree holds the MR commit');
  assert.equal(norm(fs.readFileSync(path.join(project, 'a.txt'), 'utf8')), 'main-branch content\n', 'main checkout untouched');
  assert.equal(fs.readFileSync(path.join(project, 'scratch.txt'), 'utf8').trim(), 'do not lose me');
  // Still on a real branch, not left detached at the MR commit (the whole
  // point of using a worktree rather than checking the MR out in place).
  assert.notEqual(git(project, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'HEAD');
  assert.notEqual(git(project, ['rev-parse', 'HEAD']).trim(), headSha);

  // Re-running moves the same worktree instead of failing on "already exists".
  const again = await localRepo.ensureWorktree({ projectPath: project, mrIid: 42, headSha });
  assert.equal(again, wt);

  await localRepo.removeWorktree({ projectPath: project, mrIid: 42 });
  assert.equal(fs.existsSync(wt), false, 'cleanup removes the throwaway checkout');
});
