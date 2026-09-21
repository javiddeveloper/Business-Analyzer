// Who signed off a review, and therefore whether a round trip counts against
// anybody.
//
// The rule (set by the team, 2026-09-13): a round trip is a negative mark, so
// it may only count when a **maintainer** has added the review/MR-<iid>.md
// file for that merge request. Remove the file and the mark goes away.
//
// The point is that the penalty is a human judgement, not a by-product of the
// tool running. coder-review writes review/MR-<iid>.md itself on every review,
// so "the file exists" was never evidence that anyone had reviewed anything —
// it only meant the tool had been pointed at that MR. What carries weight is a
// maintainer committing that file, which is a deliberate act by someone with
// the standing to make it.
//
// Identity matching is deliberately generous in the directions that are safe:
// git records a free-text name and an email, GitLab records a username and a
// display name, and in this org they line up in different ways per person
// (j_sattar commits as name "j_sattar" with a personal gmail, so the name
// matches the username while the email matches nothing). A false negative
// here silently drops a legitimate sign-off; a false positive requires
// someone to already be a maintainer, so leaning generous is the safer error.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const GIT_TIMEOUT_MS = 20000;
const MAX_BUFFER = 20 * 1024 * 1024;

// Maintainer and above. 40 = Maintainer, 50 = Owner. Developers (30) are the
// people being reviewed; their own file would be marking their own homework.
const MAINTAINER_ACCESS_LEVEL = 40;

function run(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER }, (err, stdout) => {
      // A missing repo, a missing review/ directory, a git that is not there:
      // all mean "no sign-off found", never a thrown error that would take
      // the whole analytics page down with it.
      resolve(err ? '' : stdout);
    });
  });
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

// Does this git author correspond to one of the given GitLab members?
function matchesMember(author, member) {
  const name = normalize(author.name);
  const emailLocal = normalize(author.email).split('@')[0];
  const username = normalize(member.username);
  const display = normalize(member.name);
  if (!username && !display) return false;
  return name === username || emailLocal === username || (!!display && name === display);
}

function isMaintainerAuthor(author, maintainers) {
  return (maintainers || []).some((m) => matchesMember(author, m));
}

// Every review/MR-<iid>.md in the repo's history, mapped to whoever added it.
//
// One `git log` for the whole directory rather than one per merge request: a
// developer can have eighty MRs, and eighty process spawns to answer a
// question about a handful of files is the kind of thing that turns a page
// load into a coffee break.
//
// --diff-filter=A gives the commit that *added* each file. Re-adding a file
// after a deletion produces a later A record, and because the log is read
// newest-first and the first record for a path wins, the current state is the
// one that counts.
//
// --all, not the current branch: the checkout this runs against is usually
// sitting on whatever feature branch was last worked on (and coder-review's
// own agent mode parks it on detached worktrees), while a maintainer commits
// the review file on the branch of the MR they were reviewing. Walking only
// HEAD's history made sign-offs appear and disappear with whatever happened
// to be checked out — verified against this repo, where review/MR-191.md is
// committed on another branch and was being reported as never committed.
async function loadSignoffs(projectPath) {
  if (!projectPath) return new Map();
  // A *and* M: the add commit answers "did a maintainer put this here", but
  // the rating lives in whatever round last rewrote the file, and the
  // documented process rewrites the trailing C/L line every round.
  const out = await run(projectPath, [
    'log', '--all', '--diff-filter=AM', '--name-only', '--date=short',
    '--format=%x01%H%x02%an%x02%ae%x02%ad', '--', 'review',
  ]);

  const byIid = new Map();
  let current = null;
  for (const rawLine of String(out).split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('\x01')) {
      const [sha, name, email, date] = line.slice(1).split('\x02');
      current = { sha, name, email, date };
      continue;
    }
    const match = line.match(/(?:^|\/)MR-(\d+)\.md$/i);
    if (!match || !current) continue;
    const iid = Number(match[1]);
    // git log walks newest first, so the first sighting of an iid is its most
    // recent touch and the last sighting is the commit that added it.
    const seen = byIid.get(iid);
    if (!seen) {
      byIid.set(iid, { ...current, path: line, latest: { ...current, path: line } });
    } else {
      // keep overwriting the add-commit fields; the final pass leaves the
      // oldest (the add), while `latest` still holds the first sighting.
      byIid.set(iid, { ...current, path: line, latest: seen.latest });
    }
  }
  return byIid;
}

// The content of a review file, wherever it still exists: working tree first,
// then the newest commit that still has it.
//
// The history fallback is the whole point. The team's workflow ends a review
// by deleting the file ("close out review for MR !227 -- all items fixed"),
// so by the time anything is scored the file is usually gone from disk while
// its rating is sitting in the commit that last held it.
async function readReportBody(projectPath, iid, relPath) {
  if (!projectPath) return null;
  const onDisk = path.join(projectPath, 'review', `MR-${iid}.md`);
  try {
    if (fs.existsSync(onDisk)) return fs.readFileSync(onDisk, 'utf8');
  } catch (e) { /* fall through to git */ }

  const file = relPath || `review/MR-${iid}.md`;
  const shas = (await run(projectPath, ['log', '--all', '--format=%H', '--', file]))
    .split('\n').map((x) => x.trim()).filter(Boolean);
  for (const sha of shas) {
    const body = await run(projectPath, ['show', `${sha}:${file}`]);
    if (body) return body;
  }
  return null;
}

// The review file's content exactly as a maintainer committed it — used for
// anything read back into scoring (the C/L rating), where "whatever happens
// to be on disk right now" is the wrong answer.
//
// readReportBody() is working-tree-first on purpose for *display* (show
// whatever is there now), but coder-review rewrites review/MR-<iid>.md on
// every run it makes, including runs made after a maintainer committed it.
// If the rating were read from the working tree, the tool's own next run
// would silently overwrite the maintainer's committed judgement in the
// score, with nothing on screen ever showing that it happened — the whole
// point of gating the rating on a real commit (loadSignoffs) would be
// defeated by the read path ignoring which commit that was.
async function readCommittedBody(projectPath, sha, relPath) {
  if (!projectPath || !sha || !relPath) return null;
  const body = await run(projectPath, ['show', `${sha}:${relPath}`]);
  return body || null;
}

// Reads the members list GitLab already returns and keeps the ones whose
// word carries this weight.
function maintainersFrom(members) {
  return (Array.isArray(members) ? members : [])
    .filter((m) => (m.access_level || 0) >= MAINTAINER_ACCESS_LEVEL)
    .map((m) => ({ username: m.username, name: m.name, access_level: m.access_level }));
}

// The verdict for one merge request, with the reason attached — the page has
// to be able to say *why* an MR does not count, or a developer whose
// round trips quietly stopped being counted has no way to find out why.
function signoffFor({ iid, exists, signoffs, maintainers }) {
  if (!exists) {
    return { counts: false, reason: 'no-file', by: null };
  }
  const added = signoffs && signoffs.get(Number(iid));
  if (!added) {
    return { counts: false, reason: 'not-committed', by: null };
  }
  if (!isMaintainerAuthor(added, maintainers)) {
    return { counts: false, reason: 'not-maintainer', by: added.name || added.email || null };
  }
  return { counts: true, reason: 'signed-off', by: added.name || added.email || null, at: added.date || null };
}

const REASON_LABELS = {
  'no-file': 'فایل review/MR-<iid>.md وجود ندارد (یا حذف شده)',
  'not-committed': 'فایل هست ولی در گیت کامیت نشده — خودِ ابزار نوشته‌اش، کسی تأییدش نکرده',
  'not-maintainer': 'فایل را کسی اضافه کرده که maintainer نیست',
  'signed-off': 'یک maintainer فایل ریویو را اضافه کرده',
};

module.exports = {
  loadSignoffs,
  readReportBody,
  readCommittedBody,
  maintainersFrom,
  signoffFor,
  isMaintainerAuthor,
  matchesMember,
  REASON_LABELS,
  MAINTAINER_ACCESS_LEVEL,
};
