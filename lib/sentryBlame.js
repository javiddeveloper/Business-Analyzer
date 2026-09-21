// Who wrote the line Sentry is pointing at.
//
// Sentry's stack trace says which file/line raised the exception; git blame
// says who last touched that line. Put together, an unresolved production
// crash stops being an anonymous number on the Sentry page and becomes
// something devScore.js can hold against the person who introduced it — see
// sentryReliability() there.
//
// Blamed against HEAD (or the issue's own `release` tag, when it resolves to
// a real commit) rather than the exact commit that shipped the crash: Sentry
// does not hand back a source-controlled ref for "the code that ran", only a
// release string whose format is whatever the team's SDK config makes it.
// This is therefore an approximation — if the surrounding function was
// rewritten since, the blamed line may no longer be the one that actually
// crashed. Good enough to point a reader at the right file and the right
// person most of the time; not a claim of certainty, which is why every
// result here carries the frame and commit it was decided from, for someone
// to check.
const { execFile } = require('child_process');
const cache = require('./cache');

const GIT_TIMEOUT_MS = 15000;
const MAX_BUFFER = 5 * 1024 * 1024;

function runGit(cwd, args) {
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

// The frame worth blaming: Sentry stores frames innermost-last, and only a
// frame Sentry itself marked inApp is this project's own code rather than a
// framework/library file that would not even exist in the checkout. First
// exception in the list (the one actually raised, for a chained error) with
// a usable file+line wins.
function culpritFrame(issue) {
  for (const ex of (issue && issue.exceptions) || []) {
    const frames = (ex.frames || []).slice().reverse();
    const hit = frames.find((f) => f.inApp && f.filename && f.lineNo != null);
    if (hit) return hit;
  }
  return null;
}

// `git blame -L n,n --porcelain` for one line: sha, then a block of
// `key value` header lines, then the content line itself (tab-prefixed).
// Only the header lines are read.
function parsePorcelain(out) {
  const lines = String(out || '').split('\n');
  const sha = (lines[0] || '').split(' ')[0] || null;
  let authorName = null;
  let authorMail = null;
  let authorTime = null;
  let summary = null;
  for (const line of lines) {
    if (line.startsWith('author ')) authorName = line.slice(7);
    else if (line.startsWith('author-mail ')) authorMail = line.slice(12).replace(/^<|>$/g, '');
    else if (line.startsWith('author-time ')) {
      const n = Number(line.slice(12));
      authorTime = Number.isFinite(n) ? n * 1000 : null;
    } else if (line.startsWith('summary ')) summary = line.slice(8);
  }
  return { sha: sha === '0000000000000000000000000000000000000000' ? null : sha, authorName, authorMail, authorTime, summary };
}

// Sentry's frame filename can be an absolute in-container path
// (/app/src/orders.js), a path relative to some build root, or already
// relative to the repo root, depending on the SDK and how it was
// configured — there is no single shape to assume. Tried longest-to-
// shortest suffix so the first candidate that actually exists in the
// checkout is used, rather than guessing one shape and failing silently on
// every project that uses another.
function candidatePaths(filename) {
  const norm = String(filename || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!norm) return [];
  const parts = norm.split('/');
  const out = [];
  for (let i = 0; i < parts.length; i++) out.push(parts.slice(i).join('/'));
  return out;
}

// A ref only worth passing to `git blame` if it actually resolves here —
// otherwise blame falls back to HEAD silently rather than throwing over a
// release tag that isn't a git ref at all (the common case).
async function resolveRef(projectPath, release) {
  if (!release) return null;
  try {
    await runGit(projectPath, ['rev-parse', '--verify', '--quiet', `${release}^{commit}`]);
    return release;
  } catch (e) {
    return null;
  }
}

async function blameLine(projectPath, filename, lineNo, ref) {
  const candidates = candidatePaths(filename);
  if (!candidates.length) throw new Error('نام فایل در استک‌تریس قابل استفاده نبود');
  let lastErr = null;
  for (const candidate of candidates) {
    try {
      const args = ['blame', '-L', `${lineNo},${lineNo}`, '--porcelain'];
      if (ref) args.push(ref);
      args.push('--', candidate);
      const out = await runGit(projectPath, args);
      return { ...parsePorcelain(out), path: candidate };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('فایل در ریپازیتوری محلی پیدا نشد');
}

// Given a git identity (email/display name from `git blame`), which roster
// member is it? The exact rule devAnalytics.js's isMrAuthor uses for the
// opposite direction (a known candidate vs a commit) — this checks every
// roster member instead of one, since here the identity is unknown going in.
// Email-local-part match is tried across the whole roster before falling
// back to an exact display-name match, rather than interleaved per person:
// a roster with both "reza" (username) and someone whose *display name*
// happens to be "reza" should prefer the username match everywhere, not
// whichever entry happens to come first in the array.
function matchRosterAuthor({ email, name }, roster) {
  const emailLocal = String(email || '').toLowerCase().split('@')[0];
  const trimmedName = String(name || '').trim();
  if (emailLocal) {
    const byEmail = (roster || []).find((p) => String(p.username || '').toLowerCase() === emailLocal);
    if (byEmail) return byEmail;
  }
  if (trimmedName) {
    const byName = (roster || []).find((p) => String(p.name || '').trim() === trimmedName);
    if (byName) return byName;
  }
  return null;
}

// The one thing this module is for: given a Sentry issue and the local
// checkout it should be blamed against, who wrote the crashing line — if
// anyone on the roster did. Never throws: a blame that can't be resolved
// (no PROJECT_PATH, the file isn't in this checkout, the line moved past
// the file's current length) is reported as `available: false` with why,
// since "we don't know" and "nobody's fault" are different findings and a
// crash on screen must not silently read as the second when it's the first.
async function blameIssue({ issue, projectPath, roster }) {
  const frame = culpritFrame(issue);
  if (!frame) {
    return { available: false, reason: 'استک‌تریس این خطا هیچ فریمی از کد خودِ پروژه ندارد.', frame: null };
  }
  if (!projectPath) {
    return { available: false, reason: 'مسیر چک‌اوت محلی این پروژه تنظیم نشده — بدون آن git blame ممکن نیست.', frame };
  }
  try {
    const ref = await resolveRef(projectPath, issue.release);
    const blame = await blameLine(projectPath, frame.filename, frame.lineNo, ref);
    if (!blame.sha) {
      return { available: false, reason: 'این خط در commit فعلی (هنوز commit نشده یا فقط محلی) قرار دارد.', frame };
    }
    const author = matchRosterAuthor({ email: blame.authorMail, name: blame.authorName }, roster);
    return {
      available: true,
      frame,
      path: blame.path,
      blamedAtRef: ref || 'HEAD',
      commit: { sha: blame.sha, summary: blame.summary, at: blame.authorTime },
      gitAuthor: { name: blame.authorName, email: blame.authorMail },
      // null (blame worked, nobody on the current roster matches — an
      // ex-employee, a bot commit, an external contributor) is a real,
      // distinct answer from `available: false` (blame itself didn't run).
      author: author ? { username: author.username, name: author.name } : null,
    };
  } catch (e) {
    return {
      available: false,
      reason: 'git blame ناموفق بود — ' + String(e.stderr || e.message || '').trim().slice(0, 200),
      frame,
    };
  }
}

// Blame doesn't change unless someone edits that exact line again, so a
// day's cache avoids re-shelling to git on every page view of an issue
// that's been sitting untouched for weeks. Keyed by issue id alone — not by
// project/roster — because a given Sentry issue always belongs to the same
// project and its culprit frame doesn't move between two people looking at
// the same issue a minute apart.
const BLAME_CACHE = 'sentry-blame-v1';
const BLAME_TTL_MS = 24 * 60 * 60 * 1000;

async function blameIssueCached({ issue, projectPath, roster, force = false }) {
  try {
    const { value } = await cache.cached(
      BLAME_CACHE, String(issue.id), BLAME_TTL_MS,
      () => blameIssue({ issue, projectPath, roster }),
      { force }
    );
    return value;
  } catch (e) {
    return { available: false, reason: e.message, frame: null };
  }
}

module.exports = {
  culpritFrame, matchRosterAuthor, blameLine, blameIssue, blameIssueCached,
  parsePorcelain, candidatePaths, resolveRef, BLAME_CACHE,
};
