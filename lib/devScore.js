// The composite developer score: one number built from what Jira and GitLab
// actually know, with every input visible so nobody has to take it on faith.
//
// Built against this org's real data (checked 2026-09-08, 40 tickets):
//   Original Estimate  100% filled  → the team's real estimating currency
//   Due date           100% filled  → on-time delivery is genuinely measurable
//   Time Spent          ~47% filled → usable, but only for the half that logs
//   Story Points          0% filled → deliberately NOT scored on; the field is
//                                     read anyway, so it starts counting by
//                                     itself if the team ever adopts it
//   Priority           ~all "Critical_SO" → no discriminating power, shown
//                                     but not scored
//
// Re-checked against the same org's GitLab data (2026-09-09), which retired
// two components that looked fine on paper and measured nothing in practice:
//
//   MR open→merge      medians of 4.2 / 6.5 / 23 / 26.4 hours across the four
//                      developers → everyone would score ~100. A component
//                      that cannot separate anyone only inflates the total,
//                      so merge speed is *reported*, never scored.
//   Round-trip MRs     11 of the 12 MRs we could check had a commit from
//                      someone else on the branch. When a metric fails for
//                      nearly everyone it is describing how the team works
//                      (pairing, a lead pushing a fixup), not who is doing
//                      badly — so its weight dropped from 30% of the old
//                      scale to 5, and it stays on screen as a fact.
//   Recency            was worth 5 points as "activity". Being at the desk
//                      today is not performance; a person on approved leave
//                      is not a worse engineer. It is now a status line at
//                      the top of the page and no part of the score.
//
// Design rules this file sticks to:
//
//  1. A component with no data is *dropped and its weight redistributed*,
//     never scored as zero. Someone who logs no time should not be ranked
//     below someone who logs time badly.
//  2. Thin evidence counts less. Each component's weight is multiplied by a
//     confidence factor n/(n+K): a code-quality score built on one review
//     carries ~17% of its nominal weight, one built on thirty carries ~86%.
//     Without this, a developer with a single reviewed MR could have 20% of
//     their score decided by that one MR — which is how a scoring system
//     loses the room's trust the first time someone checks its working.
//  3. Over- and under-estimating are penalised symmetrically (log2 ratio):
//     taking 2× the estimate and taking half of it are the same size of
//     miss, and a score that only punished overruns would quietly reward
//     padding the estimate.
// Weights are relative, not required to total 100 — compute() normalizes
// over whichever components have data anyway.
const difficulty = require('./difficulty');
const workCalendar = require('./workCalendar');

const WEIGHTS = {
  onTime: 25,
  estimateAccuracy: 25,
  codeQuality: 20,
  completion: 15,
  timeLogging: 10,
  mrSize: 15,
  reworkFree: 5,
  sentryReliability: 15,
  // Provisional weight — see workUtilization()'s own comment for why this
  // is the one component in the table the user explicitly asked to keep
  // modest until it's proven out, rather than a settled judgement call.
  workUtilization: 10,
};

const LABELS = {
  onTime: 'تحویل به‌موقع (نسبت به Due date)',
  estimateAccuracy: 'دقت تخمین (Original Estimate در برابر Time Spent)',
  codeQuality: 'کیفیت کد (یافته‌های ریویو، نسبت به اندازه‌ی MR)',
  completion: 'تکمیل تسک‌ها (Done از کل تسک‌های بازه)',
  timeLogging: 'ثبت زمان روی تسک‌های Review/Done',
  mrSize: 'اندازه‌ی Merge Requestها (L — چقدر کد باید خوانده شود)',
  reworkFree: 'برنچ تک‌نویسنده (بدون کامیت از فرد دیگر)',
  sentryReliability: 'خطاهای Sentry ردیابی‌شده تا کامیت این فرد (git blame)',
  workUtilization: 'ساعت ثبت‌شده در برابر ظرفیت روزهای کاری (۸ ساعت/روز)',
};

function clamp100(n) {
  return Math.max(0, Math.min(100, n));
}

// Sample size at which a component carries half its nominal weight.
const CONFIDENCE_K = 5;

function confidence(sampleSize) {
  const n = Math.max(0, Number(sampleSize) || 0);
  return n / (n + CONFIDENCE_K);
}

// |log2(spent / estimate)|: 0 when spot on, 1 at either 2× over or 2× under,
// 2 at 4×. Scaled so a 2× miss scores 50 and a 4× miss scores 0.
function estimateTaskScore(estimateHours, spentHours) {
  const drift = Math.abs(Math.log2(spentHours / estimateHours));
  return clamp100(100 * (1 - drift / 2));
}

// Tasks whose estimate *and* logged time are both present. Anything else
// can't say whether the estimate was any good.
function estimateAccuracy(tasks) {
  const usable = tasks.filter((t) => t.estimateHours > 0 && t.spentHours > 0);
  if (!usable.length) return null;
  const scores = usable.map((t) => estimateTaskScore(t.estimateHours, t.spentHours));
  const totalEst = usable.reduce((a, t) => a + t.estimateHours, 0);
  const totalSpent = usable.reduce((a, t) => a + t.spentHours, 0);
  const driftPct = Math.round(((totalSpent - totalEst) / totalEst) * 100);
  return {
    score: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length),
    sampleSize: usable.length,
    detail: `${usable.length} تسک با تخمین و زمان ثبت‌شده — مجموع تخمین ${Math.round(totalEst)} ساعت در برابر ${Math.round(totalSpent)} ساعت واقعی (${driftPct > 0 ? '+' : ''}${driftPct}٪)`,
  };
}

// Delivered by its due date — graded by *how* late, not pass/fail.
//
// Measured against this team's real history (2026-09-08): of 87 closed
// tickets only 6 met their due date, most landing 8-90 days after it. A
// binary on-time test there scores almost everyone ~4/100, which flattens
// the whole team into "failing" and tells you nothing about who is closer to
// their dates than whom. Grading the lateness keeps the metric honest about
// the delay while still separating two days late from two months late.
//
// A resolved task is judged on when it resolved; an unresolved one only
// counts once it is *already* past due, because a task still inside its
// deadline is not yet evidence either way.
//
// The unit is working days (lib/workCalendar.js), not calendar days: a task
// due Wednesday and delivered the following Sunday is one working day late
// somewhere that doesn't work Thu/Fri, not four. LATE_ZERO_DAYS was picked
// back when the unit was calendar days; it now means 30 working days (~6
// weeks), a stricter bar in calendar time, and that is intentional — the
// same real lateness should cost the same regardless of which two weekdays
// happened to fall inside it.
const LATE_ZERO_DAYS = 30; // this many working days past due scores 0 for that task

function lateTaskScore(daysLate) {
  if (daysLate <= 0) return 100;
  return clamp100(100 * (1 - daysLate / LATE_ZERO_DAYS));
}

function onTime(tasks, now = Date.now()) {
  const scores = [];
  let considered = 0;
  let strictlyOnTime = 0;
  let totalDaysLate = 0;
  for (const t of tasks) {
    if (!t.dueDate) continue;
    const due = new Date(`${t.dueDate}T23:59:59`).getTime();
    let daysLate = null;
    if (t.resolvedAt) {
      const resolvedMs = new Date(t.resolvedAt).getTime();
      // On-time stays a plain (non-positive) calendar difference — only an
      // actually-late span gets converted to working days, since
      // workingDaysBetween counts elapsed time forward and has nothing
      // useful to say about "how early".
      daysLate = resolvedMs <= due ? (resolvedMs - due) / 86400000 : workCalendar.workingDaysBetween(due, resolvedMs);
    } else if (now > due) {
      daysLate = workCalendar.workingDaysBetween(due, now);
    }
    if (daysLate === null) continue; // open and not yet due — no evidence yet
    considered++;
    if (daysLate <= 0) strictlyOnTime++;
    else totalDaysLate += daysLate;
    scores.push(lateTaskScore(daysLate));
  }
  if (!considered) return null;
  const lateCount = considered - strictlyOnTime;
  const avgLate = lateCount ? Math.round(totalDaysLate / lateCount) : 0;
  return {
    score: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length),
    sampleSize: considered,
    strictlyOnTime,
    avgDaysLate: avgLate,
    detail: `${strictlyOnTime} از ${considered} تسک دقیقاً سر موعد` +
      (lateCount ? ` — ${lateCount} تسک به‌طور میانگین ${avgLate} روز کاری دیرتر (نمره به تناسب میزان تأخیر کم می‌شود، نه صفر مطلق)` : ''),
  };
}

// One review record per merge request, keeping the newest.
//
// activity.js appends a record every time a review *runs*, and re-running is
// routine — the real log has one MR reviewed five times in a single evening.
// Averaging those five treated one merge request as five pieces of evidence
// and let the number of times somebody clicked ▶ move their score.
//
// The newest run wins because it describes the code as it stands now: the
// findings drop between runs when the author fixes them, which is exactly
// the behaviour worth crediting. Re-running alone changes nothing — the
// review reads the same diff and returns the same findings.
function dedupeReviews(reviews) {
  const latest = new Map();
  for (const r of reviews || []) {
    const key = `${r.projectId}!${r.mrIid}`;
    const prev = latest.get(key);
    if (!prev || (r.at || 0) >= (prev.at || 0)) latest.set(key, r);
  }
  return Array.from(latest.values());
}

function weightedFindings(review) {
  const c = review.severityCounts || {};
  return (c.High || 0) * 3 + (c.Medium || 0) * 1.5 + (c.Low || 0) * 0.5;
}

// Findings scale with how much code was changed, so the raw count compares
// nobody fairly: on this org's real reviews, 12 findings spread over 49 files
// is a cleaner merge request than 6 over 4 files. Dividing by √files rather
// than by files is the middle ground — it accepts that a bigger MR earns more
// findings without letting a huge one buy immunity by sheer size.
//
// A record with no `filesReviewed` (older entries, before it was logged) is
// read as a single-file review — the strictest reading available, so a
// missing size can never flatter anyone.
function findingDensity(review) {
  return weightedFindings(review) / Math.sqrt(Math.max(1, review.filesReviewed || 1));
}

// Halving, not a straight line to zero.
//
// The old curve subtracted 16.6 points per weighted finding, which hit zero
// at ~6 — and a routine review in this org returns 10 to 14 (five Mediums and
// six Lows is a *normal* MR here). Every developer therefore scored exactly 0
// on code quality, and a fifth of the composite score was a constant. Decay
// keeps discriminating wherever the data actually sits: on the current review
// log it separates the team into 47 / 68 / 91 instead of 0 / 0 / 0.
const QUALITY_HALF_LIFE = 3; // density at which a review scores 50

function reviewQualityScore(review) {
  return clamp100(100 * Math.pow(0.5, findingDensity(review) / QUALITY_HALF_LIFE));
}

function codeQuality(reviews) {
  const perMr = dedupeReviews(reviews);
  if (!perMr.length) return null;
  const scores = perMr.map(reviewQualityScore);
  const avgDensity = perMr.reduce((a, r) => a + findingDensity(r), 0) / perMr.length;
  const avgFindings = perMr.reduce((a, r) => a + weightedFindings(r), 0) / perMr.length;
  return {
    score: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length),
    sampleSize: perMr.length,
    detail: `${perMr.length} MR ریویوشده (آخرین ریویوی هر MR) — به‌طور میانگین ${Math.round(avgFindings * 10) / 10} امتیاز وزنیِ یافته، که نسبت به اندازه‌ی MR می‌شود ${Math.round(avgDensity * 100) / 100}`,
  };
}

// A task that reached Review or Done without a single logged hour is a hole
// in every other number here: estimate accuracy can't be measured on it, and
// the month's totals under-report the real effort. Scored separately rather
// than folded into estimate accuracy, so "estimates are off" and "nobody
// logged time" stay distinguishable — they call for different conversations.
//
// Only tasks that got that far count. A ticket still in To Do has no time to
// log yet, and penalising it would just be a headcount of open work.
function isReviewOrDone(task) {
  return task.statusCategory === 'done' || /review/i.test(String(task.status || ''));
}

// A Story or Epic is a container, not something anyone logs hours against
// directly — the work (and the time) lives on its sub-tasks. Exported so
// every place that flags "reached Review/Done with no logged time" — the
// team-overview attention count, the monthly/sprint noTimeLogged tallies,
// the task board's orange "needs-worklog" border — uses the same rule this
// file's own score does, instead of each re-deriving a narrower version of
// it and disagreeing about whether a Story counts.
function isStoryOrEpic(task) {
  return /story|epic/i.test(String((task && task.type) || ''));
}

// Whether a task is fair evidence for "did this person log their time":
// reached Review/Done, and is not a container whose own time was always
// going to be logged elsewhere.
function needsTimeLog(task) {
  return isReviewOrDone(task) && !isStoryOrEpic(task);
}

function timeLogging(tasks) {
  const eligible = tasks.filter(needsTimeLog);
  if (!eligible.length) return null;
  
  const logged = eligible.filter((t) => t.spentHours > 0);
  const missing = eligible.length - logged.length;
  return {
    score: Math.round(100 * (logged.length / eligible.length)),
    sampleSize: eligible.length,
    detail: `${logged.length} از ${eligible.length} تسکِ رسیده به Review/Done زمان ثبت‌شده دارد` +
      (missing ? ` — ${missing} تسک بدون ثبت زمان` : ''),
  };
}

// An MR with a commit from somebody other than its author.
//
// Deliberately no longer called rework in the score, and deliberately small:
// on this org's data 11 of the 12 checkable MRs trip it, which is the
// signature of a team that pairs and lets a lead push a fixup — not of a
// team that redoes everything. Kept because a *change* in it is worth
// noticing, weighted at 5 because its level is not.
//
// Only MRs this tool actually reviewed carry the signal (see devAnalytics.js).
// Merge request size, from the maintainer's L rating.
//
// This is the rule the team asked for explicitly: merge requests should not be
// big. L* and L** cost nothing, L*** is the turning point, L***** is what the
// rule exists to discourage. The reason is not neatness — past a certain size
// both human and automated review measurably stop finding things, so a large
// MR is a review that did not really happen.
//
// Complexity deliberately does not excuse size. A hard change is the one you
// least want delivered as a ninety-file diff, because that is exactly where
// review quality collapses.
//
// Only rated MRs count. An MR with no L rating is not assumed small — it is
// simply not evidence, and contributes nothing either way.
function mrSize(ratings) {
  const rated = (ratings || []).filter((r) => r.length != null);
  if (!rated.length) return null;
  const scores = rated.map((r) => difficulty.lengthScore(r.length));
  const big = rated.filter((r) => r.length >= 4);
  const counts = {};
  for (const r of rated) counts[r.length] = (counts[r.length] || 0) + 1;
  const spread = [1, 2, 3, 4, 5]
    .filter((n) => counts[n])
    .map((n) => 'L' + '*'.repeat(n) + '×' + counts[n])
    .join('، ');
  return {
    score: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length),
    sampleSize: rated.length,
    detail: `${rated.length} MR امتیاز اندازه دارد — ${spread}` +
      (big.length ? ` · ${big.length} MR بزرگ (L**** یا بالاتر)` : ' · هیچ MR بزرگی نیست'),
  };
}

function reworkFree(analytics) {
  const reported = analytics.reportedMRs || 0;
  if (!reported) return null;
  const rt = analytics.roundTripMRs || 0;
  return {
    score: Math.round(100 * (1 - rt / reported)),
    sampleSize: reported,
    detail: `${reported - rt} از ${reported} MR فقط کامیت خودِ نویسنده را دارد` +
      (rt ? ' — در این تیم کامیت دیگران روی برنچ رایج است، پس این عدد بیشتر توصیف روش کار است تا نمره‌ی فرد (وزن ۵٪)' : ''),
  };
}

// Production crashes git blame traced to this person's own commit
// (lib/sentryBlame.js) — the one component here that is evidence of harm
// rather than evidence of good work, so its "no data" case has to be read
// differently from every other component's.
//
// `blamed`: the Sentry issues, in this window, whose crashing line blamed to
// *this* person — [{ level, resolved }]. `searched`: how many Sentry issues
// were actually blame-resolved to *anyone* on the team this window — the
// team-wide evidence base, not just this person's share of it.
//
// No blamed issues is scored 100, not treated as missing data: the rest of
// this file drops a component to "no evidence" when nothing was measured,
// but here the measurement is "did we find any", and a real search that
// found none *is* the finding — dropping it would silently forgive every
// developer nobody has looked for a crash under. It only takes 100 (rather
// than being skipped) once `searched` confirms the search actually ran
// somewhere on the team; a Sentry integration that was never configured
// giving everyone a free 100 here would read as "clean" when it is really
// "never checked".
//
// Weighted by severity, and a resolved crash costs 60% less than one still
// open — the mistake is the same size either way, but leaving it unresolved
// is the additional, ongoing part of the story this number should reflect.
function blameWeight(level) {
  const l = String(level || '').toLowerCase();
  if (l === 'fatal') return 30;
  if (l === 'error') return 20;
  if (l === 'warning') return 8;
  return 4; // info/debug/unknown
}

function sentryReliability(blamed, searched) {
  if (!searched) return null;
  if (!blamed.length) {
    return {
      score: 100,
      sampleSize: searched,
      detail: `از ${searched} خطای Sentry ردیابی‌شده در این بازه، هیچ‌کدام به کامیت این فرد نرسید.`,
    };
  }
  const penalty = blamed.reduce((sum, b) => sum + blameWeight(b.level) * (b.resolved ? 0.4 : 1), 0);
  const unresolvedCount = blamed.filter((b) => !b.resolved).length;
  return {
    score: Math.round(clamp100(100 - penalty)),
    sampleSize: searched,
    detail: `${blamed.length} خطای Sentry به کامیت این فرد ردیابی شد` +
      (unresolvedCount ? ` — ${unresolvedCount} مورد هنوز حل‌نشده` : ' — همه حل‌شده') +
      ` (از ${searched} خطای بررسی‌شده در کل تیم).`,
  };
}

// Logged hours against the working-day capacity of the window being judged
// — "did this person's own logged time look like roughly a full-time
// person's hours, given how many working days actually existed in this
// window". Provisional: the user asked for this explicitly but flagged the
// weight as an open question, so it starts at a modest WEIGHTS.
// workUtilization rather than a confident one — see that entry's comment.
//
// Needs a real [since, until) window: "all time" has no fixed weekly
// capacity to compare against, so without both bounds this is simply not
// scored (null), the same as any other component with nothing to measure
// against — never a guessed baseline.
//
// Deliberately does not know about approved leave, part-time schedules, or
// meetings/reviews that consume real hours without a task to log them
// against — exactly the kind of gap this file's own recency rule exists to
// warn about ("a person on approved leave is not a worse engineer"). This
// component can currently make that same mistake for anyone who was out
// for reasons the data here cannot see. Capped at 100 rather than penalising
// logging *more* than 8h/working day — overtime is not a defect.
const HOURS_PER_WORKDAY = 8;

function workUtilization(tasks, since, until) {
  if (!since || !until) return null;
  const fromMs = new Date(`${since}T00:00:00`).getTime();
  const toMs = new Date(`${until}T23:59:59`).getTime();
  if (!(toMs > fromMs)) return null;
  const workDays = workCalendar.workingDaysBetween(fromMs, toMs);
  if (workDays < 1) return null; // a window shorter than one working day proves nothing either way
  const expected = workDays * HOURS_PER_WORKDAY;
  const logged = tasks.reduce((sum, t) => sum + (Number(t.spentHours) || 0), 0);
  const pct = expected > 0 ? Math.round((logged / expected) * 100) : 0;
  return {
    score: clamp100(pct),
    sampleSize: Math.round(workDays),
    detail: `${Math.round(logged)} ساعت ثبت‌شده در این بازه، در برابر ظرفیت ${Math.round(expected)} ساعت` +
      ` (${Math.round(workDays)} روز کاری × ${HOURS_PER_WORKDAY} ساعت) — ${pct}٪.`,
  };
}

function completion(tasks) {
  if (!tasks.length) return null;
  const done = tasks.filter((t) => t.statusCategory === 'done').length;
  return {
    score: Math.round(100 * (done / tasks.length)),
    sampleSize: tasks.length,
    detail: `${done} از ${tasks.length} تسک این بازه به وضعیت Done رسیده`,
  };
}

// tasks: the Jira issues assigned to this person in the window
// analytics: the GitLab-derived numbers (reportedMRs / roundTripMRs / …)
// reviews: this tool's own review records for them (activity.js)
// skip: component keys to leave out entirely (their weight redistributes,
// exactly as if they had no data). Used for the sprint score, where
// "completion" is progress through a sprint still running, not a verdict on
// it — see monthly.latestSprint.
//
// Recency is not an input. How recently someone worked says nothing about
// how well they worked, and scoring it meant a week of approved leave read
// as a performance drop. It is displayed beside the score as a status, which
// is what it always was.
function compute({ tasks = [], analytics = {}, reviews = [], now = Date.now(), skip = [], ratings = null, sentryBlame = null, since = null, until = null } = {}) {
  // The maintainer C/L ratings for this window. Passed explicitly by the
  // sprint/month slices, which score a subset; otherwise taken from the
  // analytics payload the page was built from.
  const rated = ratings || analytics.ratings || [];
  // Same explicit-or-from-analytics pattern as `rated` above, for the same
  // reason: a sprint/month slice can pass its own subset, and the main
  // build attaches it to `analytics` once rather than threading a fourth
  // parameter through every call site that doesn't care about it.
  const blame = sentryBlame || analytics.sentryBlame || null;
  // since/until likewise: the main build has an explicit date-filter window
  // to pass; the sprint/month slices don't have a clean Gregorian window for
  // their Jalali period yet, so they simply don't pass one and
  // workUtilization scores null for them (no data), same as any other
  // component with nothing to measure against.
  const win = since || until ? { since, until } : analytics.window || {};
  const raw = {
    onTime: onTime(tasks, now),
    estimateAccuracy: estimateAccuracy(tasks),
    codeQuality: codeQuality(reviews),
    completion: completion(tasks),
    timeLogging: timeLogging(tasks),
    mrSize: mrSize(rated),
    reworkFree: reworkFree(analytics),
    sentryReliability: blame ? sentryReliability(blame.blamed || [], blame.searched || 0) : null,
    workUtilization: workUtilization(tasks, win.since, win.until),
  };

  // Weight actually carried by each component = nominal weight × confidence
  // in its sample. Renormalized over whatever has data, so a missing input
  // never silently drags the total down — it just stops having a say.
  for (const key of skip) raw[key] = null;

  const carried = {};
  for (const key of Object.keys(WEIGHTS)) {
    carried[key] = raw[key] ? WEIGHTS[key] * confidence(raw[key].sampleSize) : 0;
  }
  const availableWeight = Object.values(carried).reduce((a, b) => a + b, 0);

  const components = Object.keys(WEIGHTS).map((key) => {
    const r = raw[key];
    return {
      key,
      label: LABELS[key],
      baseWeight: WEIGHTS[key],
      effectiveWeight: availableWeight ? Math.round((carried[key] / availableWeight) * 1000) / 10 : 0,
      confidence: r ? Math.round(confidence(r.sampleSize) * 100) : 0,
      score: r ? r.score : null,
      sampleSize: r ? r.sampleSize : 0,
      detail: r ? r.detail : 'داده‌ای برای محاسبه نبود — وزنش بین بقیه پخش شد',
      available: !!r,
    };
  });

  if (!availableWeight) {
    return { score: null, components, availableWeight: 0, reason: 'هیچ داده‌ای برای امتیازدهی خودکار نبود.' };
  }

  const total = components.reduce(
    (sum, c) => (c.available ? sum + c.score * (carried[c.key] / availableWeight) : sum),
    0
  );

  // Complexity does not score on its own — being handed a hard ticket is not
  // an achievement. It adjusts what the delivered work is worth: the same
  // result counts for more on C**** than on C*, and the same slip costs less.
  // Centred on C** (the ordinary case) so a team working on ordinary tickets
  // is neither flattered nor punished by the scale existing at all.
  //
  // Bounded to ±12 points. It is a maintainer's one-character judgement on a
  // handful of MRs, which is worth a nudge, not a different verdict.
  //
  // Damped by the same confidence factor as every component (rule 2 at the
  // top of this file), which it used to skip. That exemption produced the
  // exact result the rule exists to prevent: on this team's real data, a
  // developer with one rated MR (C****) took the full +12 — 17% of their
  // final 72 — from a single character on a single merge request, while
  // their code-quality component, built on that same one MR, was correctly
  // scaled down to 17% of its nominal weight. Thin evidence cannot be worth
  // little in one place and everything in another; with n=1 that +12 is now
  // +2, and it grows as more MRs get rated.
  //
  // Confidence is applied before the cap, not after, so ±12 stays the
  // absolute ceiling on this mechanism at any sample size.
  const withComplexity = rated.filter((r) => r.complexity != null);
  const avgWeight = withComplexity.length
    ? withComplexity.reduce((a, r) => a + difficulty.complexityWeight(r.complexity), 0) / withComplexity.length
    : 1;
  const complexityConfidence = confidence(withComplexity.length);
  const adjustment = withComplexity.length
    ? Math.max(-12, Math.min(12, Math.round((avgWeight - 1) * 20 * complexityConfidence)))
    : 0;
  const adjusted = clamp100(total + adjustment);

  const usedCount = components.filter((c) => c.available).length;
  return {
    score: Math.round(adjusted),
    baseScore: Math.round(total),
    complexityAdjustment: adjustment,
    complexitySample: withComplexity.length,
    complexityConfidence: Math.round(complexityConfidence * 100),
    components,
    availableWeight,
    reason: `میانگین وزنی ${usedCount} مؤلفه‌ی دارای داده (از ${Object.keys(WEIGHTS).length} مؤلفه)؛ وزن هر مؤلفه در ضریب اطمینانِ حجم نمونه‌اش ضرب شده.` +
      // The sample size and its confidence are named, not just the number:
      // "+2 for complexity" invites the question this answers, and a reader
      // who cannot see that it rests on one MR cannot judge it.
      (adjustment
        ? ` سپس ${adjustment > 0 ? '+' : ''}${adjustment} بابت پیچیدگی کارها (C) روی ${withComplexity.length} MR رتبه‌دار` +
          ` (این هم مثل بقیه در ضریب اطمینان ${Math.round(complexityConfidence * 100)}٪ ضرب شده).`
        : ''),
  };
}

module.exports = { compute, mrSize, WEIGHTS, LABELS, confidence, CONFIDENCE_K, estimateTaskScore, lateTaskScore, timeLogging, isReviewOrDone, isStoryOrEpic, needsTimeLog, estimateAccuracy, onTime, codeQuality, reworkFree, completion, dedupeReviews, findingDensity, reviewQualityScore, QUALITY_HALF_LIFE, sentryReliability, blameWeight, workUtilization, HOURS_PER_WORKDAY };
