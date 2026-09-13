// The two-axis rating a maintainer leaves at the end of review/MR-<iid>.md:
//
//   C<stars> — complexity / how much care it needs, independent of volume
//     C*     trivial
//     C**    ordinary bug or small task
//     C***   real business risk, needs attention
//     C****  delicate logic, easy to get wrong
//     C***** genuinely hard, needs deep expertise
//
//   L<stars> — how much code actually has to be read, independent of difficulty
//     L*     a few files, quick to check
//     L**    small, contained set
//     L***   moderate spread across the codebase
//     L****  many files, large diff
//     L***** this MR is very big
//
// They are deliberately separate axes. A one-line change to a payment rule is
// C**** L*, and a mechanical rename across ninety files is C* L*****. Collapsing
// them into one "difficulty" number loses exactly the distinction that makes
// either of them useful.
//
// Nothing here invents a rating. An MR with no marker gets none, and scores
// nothing for it — a missing rating must never be read as "easy", which is
// what a default of zero would quietly mean.

// The historical form: a bare run of asterisks on the last line, before the
// C/L split existed. Read as complexity, since that is what it was being used
// for, and only when no explicit C rating is present.
const BARE_RE = /^\*{1,5}$/;
const AXIS_RE = /(^|\s)([CL])\s*(\*{1,5})(?=\s|$)/gi;

// Scans from the end: the rating lives at the bottom of the file, and a
// "C***" appearing mid-document is prose about the scale (this project's own
// knowledge base describes it), not the verdict for this MR.
const TAIL_LINES = 12;

function parseRating(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.replace(/\r/g, '').trim())
    .filter(Boolean);
  if (!lines.length) return null;

  const tail = lines.slice(-TAIL_LINES);
  let complexity = null;
  let length = null;

  // Later lines win: the closing line of the file is the final word, and a
  // revision log can carry earlier rounds' ratings above it.
  for (const line of tail) {
    AXIS_RE.lastIndex = 0;
    let m;
    while ((m = AXIS_RE.exec(line))) {
      const axis = m[2].toUpperCase();
      const stars = m[3].length;
      if (axis === 'C') complexity = stars;
      else length = stars;
    }
  }

  if (complexity == null) {
    const last = lines[lines.length - 1];
    if (BARE_RE.test(last)) complexity = last.length;
  }

  if (complexity == null && length == null) return null;
  return { complexity, length };
}

const COMPLEXITY_LABELS = {
  1: 'خیلی راحت',
  2: 'معمولی — باگ/کار کوچک',
  3: 'ریسک بیزینسی واقعی، نیاز به توجه',
  4: 'منطق ظریف/حساس، به‌راحتی می‌شود اشتباه کرد',
  5: 'واقعاً سخت، نیاز به تخصص عمیق',
};

const LENGTH_LABELS = {
  1: 'چند فایل، سریع قابل بررسی',
  2: 'مجموعه‌ی کوچک و محدود',
  3: 'پخش متوسط در کدبیس',
  4: 'فایل/کلاس زیاد، دیف بزرگ',
  5: 'این MR خیلی بزرگ است',
};

// Big merge requests are the thing the team explicitly wants discouraged, so
// L is scored downward: L* and L** are fine, L*** is the turning point, and
// L***** is the score this rule exists to punish. Complexity does not excuse
// size — a hard problem is exactly the one you least want delivered as a
// ninety-file diff, because that is where review quality collapses.
const LENGTH_SCORE = { 1: 100, 2: 100, 3: 70, 4: 35, 5: 0 };

function lengthScore(stars) {
  return stars == null ? null : (LENGTH_SCORE[stars] ?? null);
}

// Complexity is not itself good or bad, so it earns no points of its own.
// It weights the work instead: finishing a C***** cleanly counts for more
// than finishing a C*, and the same slip costs less on hard work than on
// trivial work. 1.0 at C** (the ordinary case) so a team working on ordinary
// tickets is neither flattered nor punished by the mere existence of this
// scale.
const COMPLEXITY_WEIGHT = { 1: 0.7, 2: 1.0, 3: 1.3, 4: 1.6, 5: 2.0 };

function complexityWeight(stars) {
  return stars == null ? 1 : (COMPLEXITY_WEIGHT[stars] ?? 1);
}

function formatRating(rating) {
  if (!rating) return '';
  const parts = [];
  if (rating.complexity) parts.push('C' + '*'.repeat(rating.complexity));
  if (rating.length) parts.push('L' + '*'.repeat(rating.length));
  return parts.join(' ');
}

module.exports = {
  parseRating,
  lengthScore,
  complexityWeight,
  formatRating,
  COMPLEXITY_LABELS,
  LENGTH_LABELS,
  LENGTH_SCORE,
  COMPLEXITY_WEIGHT,
};
