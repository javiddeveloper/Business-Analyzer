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
const WEIGHTS = {
  estimateAccuracy: 30,
  onTime: 25,
  codeQuality: 20,
  reworkFree: 10,
  completion: 10,
  activity: 5,
};

const LABELS = {
  estimateAccuracy: 'دقت تخمین (Original Estimate در برابر Time Spent)',
  onTime: 'تحویل به‌موقع (نسبت به Due date)',
  codeQuality: 'کیفیت کد (بر اساس یافته‌های ریویو)',
  reworkFree: 'بدون رفت‌وبرگشت (کامیت از فرد دیگر روی برنچ)',
  completion: 'تکمیل تسک‌ها (Done از کل تسک‌های بازه)',
  activity: 'فعالیت اخیر',
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
const LATE_ZERO_DAYS = 30; // this far past due scores 0 for that task

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
      daysLate = (new Date(t.resolvedAt).getTime() - due) / 86400000;
    } else if (now > due) {
      daysLate = (now - due) / 86400000;
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
      (lateCount ? ` — ${lateCount} تسک به‌طور میانگین ${avgLate} روز دیرتر (نمره به تناسب میزان تأخیر کم می‌شود، نه صفر مطلق)` : ''),
  };
}

// Weighted findings per review, same scale activity.js has always used:
// 0 findings → 100, ~6 weighted points (≈ two High) → ~0.
function codeQuality(reviews) {
  if (!reviews || !reviews.length) return null;
  const weighted = reviews.reduce((sum, r) => {
    const c = r.severityCounts || {};
    return sum + (c.High || 0) * 3 + (c.Medium || 0) * 1.5 + (c.Low || 0) * 0.5;
  }, 0);
  const avg = weighted / reviews.length;
  return {
    score: Math.round(clamp100(100 - avg * 16.6)),
    sampleSize: reviews.length,
    detail: `${reviews.length} ریویو، به‌طور میانگین ${Math.round(avg * 10) / 10} امتیاز وزنیِ یافته در هر ریویو`,
  };
}

// An MR someone else had to commit onto is rework. Only MRs this tool
// actually reviewed carry that signal (see devAnalytics.js).
function reworkFree(analytics) {
  const reported = analytics.reportedMRs || 0;
  if (!reported) return null;
  const rt = analytics.roundTripMRs || 0;
  return {
    score: Math.round(100 * (1 - rt / reported)),
    sampleSize: reported,
    detail: `${reported - rt} از ${reported} MR بدون کامیت اصلاحی از فرد دیگر`,
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

// Full marks up to two days idle, then down 12 points a day.
function activity(lastActivityMs, now = Date.now()) {
  if (!lastActivityMs) return null;
  const days = (now - lastActivityMs) / 86400000;
  return {
    score: Math.round(clamp100(days <= 2 ? 100 : 100 - (days - 2) * 12)),
    sampleSize: 1,
    detail: `آخرین فعالیت ${Math.round(days * 10) / 10} روز پیش`,
  };
}

// tasks: the Jira issues assigned to this person in the window
// analytics: the GitLab-derived numbers (reportedMRs / roundTripMRs / …)
// reviews: this tool's own review records for them (activity.js)
function compute({ tasks = [], analytics = {}, reviews = [], lastActivityMs = null, now = Date.now() } = {}) {
  const raw = {
    estimateAccuracy: estimateAccuracy(tasks),
    onTime: onTime(tasks, now),
    codeQuality: codeQuality(reviews),
    reworkFree: reworkFree(analytics),
    completion: completion(tasks),
    activity: activity(lastActivityMs, now),
  };

  // Weight actually carried by each component = nominal weight × confidence
  // in its sample. Renormalized over whatever has data, so a missing input
  // never silently drags the total down — it just stops having a say.
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
  const usedCount = components.filter((c) => c.available).length;
  return {
    score: Math.round(total),
    components,
    availableWeight,
    reason: `میانگین وزنی ${usedCount} مؤلفه‌ی دارای داده (از ${Object.keys(WEIGHTS).length} مؤلفه)؛ وزن هر مؤلفه در ضریب اطمینانِ حجم نمونه‌اش ضرب شده.`,
  };
}

module.exports = { compute, WEIGHTS, LABELS, confidence, CONFIDENCE_K, estimateTaskScore, lateTaskScore, estimateAccuracy, onTime, codeQuality, reworkFree, completion, activity };
