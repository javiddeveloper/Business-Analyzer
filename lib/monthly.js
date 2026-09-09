// Per-month performance rows — the shape the Excel export and the dashboard
// chart both read from, so the spreadsheet and the screen can never tell
// different stories about the same month.
//
// Each month is scored with the very same devScore.compute() the overall
// number uses, just fed that month's slice. That matters: a monthly column
// computed by a second, slightly different formula is how a report ends up
// disagreeing with the page it was exported from.
const devScore = require('./devScore');

// The team reads Jalali dates, so the sheet carries a Jalali month label
// beside the ISO one. Both: the ISO key is what sorts correctly and what the
// chart's categories key off, while the label is what a person reads.
// Node's Intl does the calendar conversion natively.
const FA_MONTH = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { month: 'long' });
const FA_YEAR = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric' });

function faMonthLabel(monthKey) {
  const d = new Date(`${monthKey}-15T00:00:00Z`);
  if (isNaN(d)) return monthKey;
  // Built from parts: {year, month:'long'} renders "۱۴۰۵ شهریور", backwards.
  return `${FA_MONTH.format(d)} ${FA_YEAR.format(d)}`;
}

function monthKey(iso) {
  return iso ? String(iso).slice(0, 7) : null;
}

// Which month does a task belong to? The month it was finished, if it was —
// otherwise the month it last moved. Attributing an unfinished task to its
// creation month would park months-old work in a month nobody is looking at.
function taskMonth(task) {
  return monthKey(task.resolvedAt) || monthKey(task.updated) || null;
}

// analytics: the GitLab-derived object (months[], reportedMRs, …)
// jiraTasks:  this developer's Jira issues, already enriched
// reviews:    this tool's own review records for them
function buildMonthlyRows({ analytics = {}, jiraTasks = [], reviews = [], now = Date.now() } = {}) {
  const months = new Map();

  const ensure = (key) => {
    if (!key) return null;
    if (!months.has(key)) {
      months.set(key, {
        month: key, mrCount: 0, roundTripCount: 0, noReportCount: 0,
        tasks: [], reviews: [],
      });
    }
    return months.get(key);
  };

  for (const m of analytics.months || []) {
    const row = ensure(m.month);
    if (!row) continue;
    row.mrCount = m.mrCount || 0;
    row.roundTripCount = m.roundTripCount || 0;
    row.noReportCount = m.noReportCount || 0;
  }
  for (const t of jiraTasks) {
    const row = ensure(taskMonth(t));
    if (row) row.tasks.push(t);
  }
  for (const r of reviews) {
    const row = ensure(monthKey(new Date(r.at).toISOString()));
    if (row) row.reviews.push(r);
  }

  return Array.from(months.values())
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((row) => {
      const done = row.tasks.filter((t) => t.statusCategory === 'done');
      // Totals cover every task that records the value at all, so each
      // column is "the sum of what is recorded" and stands on its own.
      const estimateHours = row.tasks.reduce((s, t) => s + (t.estimateHours || 0), 0);
      const spentHours = row.tasks.reduce((s, t) => s + (t.spentHours || 0), 0);
      // Drift can only be measured where both numbers exist — often a small
      // subset, since under half the tickets log time. Comparing the two
      // totals above instead would read as a huge overrun/underrun that is
      // really just missing worklogs, so the basis is reported alongside it.
      const withBoth = row.tasks.filter((t) => t.estimateHours > 0 && t.spentHours > 0);
      const estimatedOfBoth = withBoth.reduce((s, t) => s + t.estimateHours, 0);
      const spentOfBoth = withBoth.reduce((s, t) => s + t.spentHours, 0);

      // Scored on this month's slice, with the *reviewed* MR counts for that
      // month rather than the all-time totals, so a good month can't be
      // dragged down by a bad quarter.
      const reportedThisMonth = Math.max(0, row.mrCount - row.noReportCount);
      const score = devScore.compute({
        tasks: row.tasks,
        analytics: { reportedMRs: reportedThisMonth, roundTripMRs: row.roundTripCount },
        reviews: row.reviews,
        // Recency is a "right now" measure; carrying it into a historical
        // month would just score every past month as stale. Left out, and
        // its weight redistributes like any other absent component.
        lastActivityMs: null,
        now,
      });

      return {
        month: row.month,
        monthFa: faMonthLabel(row.month),
        mrCount: row.mrCount,
        roundTripCount: row.roundTripCount,
        taskCount: row.tasks.length,
        doneCount: done.length,
        estimateHours: Math.round(estimateHours * 10) / 10,
        spentHours: Math.round(spentHours * 10) / 10,
        estimateDriftPct: estimatedOfBoth > 0
          ? Math.round(((spentOfBoth - estimatedOfBoth) / estimatedOfBoth) * 100)
          : null,
        driftBasis: withBoth.length,
        reviewCount: row.reviews.length,
        score: score.score,
        components: Object.fromEntries(score.components.map((c) => [c.key, c.score])),
      };
    });
}

// Groups tasks by sprint and orders them by when they were last worked on,
// oldest first. Sprint *names* encode dates here (`Sprint-61-050616-50631`)
// so sorting them would usually work — until one is renamed or numbered
// differently, at which point it silently orders wrong. Timestamps can't.
function sprintsByRecency(tasks) {
  const bySprint = new Map();
  for (const t of tasks) {
    if (!t.sprint) continue;
    if (!bySprint.has(t.sprint)) bySprint.set(t.sprint, []);
    bySprint.get(t.sprint).push(t);
  }
  return Array.from(bySprint, ([name, items]) => ({
    name, items,
    newest: Math.max(...items.map((t) => Date.parse(t.updated) || 0)),
  })).sort((a, b) => a.newest - b.newest);
}

// Scores one sprint's slice. `completion` is deliberately skipped: a sprint
// still running has nothing Done yet, and calling that 0% would say "this
// sprint failed" about a sprint in flight. Progress is reported separately
// as doneCount/taskCount, which is what that number actually is.
function scoreSprint(items, now) {
  return devScore.compute({
    tasks: items,
    // Sprint scope is Jira-side; MR-derived components have no per-sprint
    // slice to work from, so they drop out and their weight redistributes.
    analytics: {},
    reviews: [],
    lastActivityMs: null,
    now,
    skip: ['completion'],
  });
}

function summarizeSprint(name, items, now) {
  const score = scoreSprint(items, now);
  return {
    name,
    taskCount: items.length,
    doneCount: items.filter((t) => t.statusCategory === 'done').length,
    // Done/Review tasks with logged time vs without — the split the sprint
    // chart stacks, and the one that says whether the other numbers can be
    // trusted at all.
    loggedCount: items.filter((t) => devScore.isReviewOrDone(t) && t.spentHours > 0).length,
    noTimeLogged: items.filter((t) => devScore.isReviewOrDone(t) && !(t.spentHours > 0)).length,
    score: score.score,
    components: score.components,
  };
}

// The last N sprints, oldest first so a chart reads left-to-right through
// time like the monthly one beside it.
function sprintSeries(tasks, { limit = 5, now = Date.now() } = {}) {
  return sprintsByRecency(tasks)
    .slice(-limit)
    .map((s) => summarizeSprint(s.name, s.items, now));
}

// The sprint this person worked in most recently, and how it scored.
//
// "Most recent" is decided by the newest `updated` timestamp among a
// sprint's tasks, not by sorting the sprint names. The names here encode
// dates (`Sprint-61-050616-50631`), so sorting them would usually work —
// until a sprint is renamed or numbered differently, at which point it would
// quietly pick the wrong one. Timestamps can't drift like that.
function latestSprint(tasks, { now = Date.now() } = {}) {
  const all = sprintsByRecency(tasks);
  if (!all.length) return null;
  const last = all[all.length - 1];
  return summarizeSprint(last.name, last.items, now);
}

// Column layout shared by the Excel sheet and anything else that renders
// these rows, so a column added here shows up everywhere at once.
//
// Every header carries its unit and every column its format — a count must
// never render as "13.0", and an hour total must not lose its decimal.
// `hint` is what the glossary sheet prints, so a reader can find out what a
// column means without asking whoever exported it.
const COLUMNS = [
  { key: 'monthFa', label: 'ماه', width: 16, format: 'text',
    hint: 'ماه شمسی. هر تسک در ماهی شمرده می‌شود که در آن بسته شده؛ اگر بسته نشده، ماهی که آخرین بار تغییر کرده.' },
  { key: 'month', label: 'ماه (میلادی)', width: 13, format: 'text',
    hint: 'همان ماه به میلادی — برای مرتب‌سازی و فیلتر.' },
  { key: 'score', label: 'امتیاز کل (۰ تا ۱۰۰)', width: 18, format: 'int',
    hint: 'میانگین وزنی مؤلفه‌های زیر. وزن هر مؤلفه در ضریب اطمینانِ حجم نمونه‌اش ضرب می‌شود و مؤلفه‌ی بدون داده حذف شده، وزنش بین بقیه پخش می‌شود. سلول خالی یعنی در آن ماه چیز قابل‌سنجشی نبود — نه اینکه صفر شده باشد.' },
  { key: 'mrCount', label: 'تعداد MR', width: 12, format: 'int',
    hint: 'Merge Requestهای ساخته‌شده در آن ماه (از گیت‌لب).' },
  { key: 'roundTripCount', label: 'MR رفت‌وبرگشتی', width: 16, format: 'int',
    hint: 'MRهایی که فرد دیگری غیر از نویسنده روی برنچشان کامیت زده. فقط برای MRهایی حساب می‌شود که این ابزار ریویوشان کرده باشد.' },
  { key: 'taskCount', label: 'تعداد تسک جیرا', width: 16, format: 'int',
    hint: 'تسک‌های جیرای منتسب به این فرد در آن ماه.' },
  { key: 'doneCount', label: 'تسک‌های Done', width: 14, format: 'int',
    hint: 'از همان تسک‌ها، آن‌هایی که به وضعیت Done رسیده‌اند.' },
  { key: 'estimateHours', label: 'مجموع تخمین (ساعت)', width: 20, format: 'decimal',
    hint: 'جمع Original Estimate همه‌ی تسک‌هایی که تخمین دارند.' },
  { key: 'spentHours', label: 'زمان ثبت‌شده (ساعت)', width: 20, format: 'decimal',
    hint: 'جمع Time Spent همه‌ی تسک‌هایی که زمان ثبت کرده‌اند. چون کمتر از نصف تسک‌ها زمان ثبت می‌کنند، این عدد مستقیماً با ستون تخمین قابل مقایسه نیست؛ مقایسه‌ی درست در دو ستون بعدی است.' },
  { key: 'estimateDriftPct', label: 'انحراف تخمین (٪)', width: 18, format: 'int',
    hint: 'فقط روی تسک‌هایی که هم تخمین دارند هم زمان ثبت‌شده. مثبت یعنی بیشتر از تخمین طول کشیده، منفی یعنی کمتر.' },
  { key: 'driftBasis', label: 'تعداد تسکِ پایه‌ی انحراف', width: 22, format: 'int',
    hint: 'ستون انحراف روی چند تسک حساب شده. عدد کم یعنی آن درصد را نباید جدی گرفت.' },
  { key: 'reviewCount', label: 'تعداد ریویو', width: 13, format: 'int',
    hint: 'ریویوهایی که همین ابزار در آن ماه برای این فرد ثبت کرده.' },
  { key: 'c_estimateAccuracy', label: 'نمره: دقت تخمین', width: 18, format: 'int',
    hint: 'تخمین چقدر به واقعیت نزدیک بوده. دو برابر شدن و نصف شدن به یک اندازه جریمه دارند، تا بزرگ گرفتن تخمین امتیاز نیاورد.' },
  { key: 'c_onTime', label: 'نمره: تحویل به‌موقع', width: 20, format: 'int',
    hint: 'نسبت به Due date و به تناسب میزان تأخیر — ۳۰ روز دیرتر نمره‌ی صفر می‌گیرد.' },
  { key: 'c_codeQuality', label: 'نمره: کیفیت کد', width: 18, format: 'int',
    hint: 'بر اساس یافته‌های ریویو، با وزن High=۳، Medium=۱٫۵، Low=۰٫۵.' },
  { key: 'c_timeLogging', label: 'نمره: ثبت زمان', width: 18, format: 'int',
    hint: 'چند درصد تسک‌هایی که به Review یا Done رسیده‌اند زمان ثبت‌شده دارند. تسک‌های To Do شمرده نمی‌شوند، چون هنوز زمانی ندارند که ثبت شود.' },
  { key: 'c_reworkFree', label: 'نمره: بدون رفت‌وبرگشت', width: 22, format: 'int',
    hint: 'چند درصد MRها بدون کامیت اصلاحی از فرد دیگر merge شده‌اند.' },
  { key: 'c_completion', label: 'نمره: تکمیل تسک‌ها', width: 20, format: 'int',
    hint: 'چند درصد تسک‌های آن ماه به Done رسیده‌اند.' },
];

function cellValue(row, key) {
  if (key.startsWith('c_')) {
    const v = row.components[key.slice(2)];
    return v == null ? '' : v;
  }
  const v = row[key];
  return v == null ? '' : v;
}

// Excel column letter for a column key. The chart references cells by
// letter, so hardcoding them means inserting a column silently repoints the
// chart at the wrong data — which it will happily plot. Adding the Jalali
// month column did exactly that once; deriving the letters removes the
// possibility.
function columnLetter(key) {
  const i = COLUMNS.findIndex((c) => c.key === key);
  if (i < 0) throw new Error(`unknown export column: ${key}`);
  let n = i + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function toSheetRows(rows) {
  return [COLUMNS.map((c) => c.label), ...rows.map((r) => COLUMNS.map((c) => cellValue(r, c.key)))];
}

// A glossary sheet. Without it, "انحراف تخمین" and "نمره: ثبت زمان" are
// guesses for anyone who was not in the room when they were defined.
function glossaryRows() {
  return [['ستون', 'یعنی چه'], ...COLUMNS.map((c) => [c.label, c.hint || ''])];
}

const GLOSSARY_COLUMNS = [{ format: 'text', width: 26 }, { format: 'wrap', width: 95 }];

// The headline numbers that are not per-month and so have nowhere to sit on
// the monthly sheet. `hoursLabel` is injected rather than imported so this
// module keeps no dependency on the delivery-metrics formatting.
function summaryRows({ author, analytics, hoursLabel = (h) => (h == null ? '' : h) }) {
  const d = analytics.delivery || {};
  const sp = analytics.latestSprint;
  const score = analytics.autoScore || {};
  const rows = [
    ['مورد', 'مقدار', 'توضیح'],
    ['توسعه‌دهنده', author, ''],
    ['امتیاز کل فعلی', score.score == null ? '' : score.score, score.reason || ''],
    [],
    ['— معیارهای تحویل (مستقیم از گیت‌لب) —', '', 'این‌ها به پر کردن هیچ فیلدی توسط کسی وابسته نیستند، پس برای همه‌ی MRها کامل‌اند.'],
    ['کل MRها', d.mrCount == null ? '' : d.mrCount, ''],
    ['MRهای merge‌شده', d.mergedCount == null ? '' : d.mergedCount, ''],
    ['میانه‌ی باز بودن MR تا merge', hoursLabel(d.medianOpenToMergeHours),
      '۹۰٪ زیر ' + hoursLabel(d.p90OpenToMergeHours) + ' · روی ' + (d.openToMergeSample || 0) + ' MR'],
    ['میانه‌ی Cycle time (اولین کامیت تا merge)', hoursLabel(d.medianCycleHours),
      'روی ' + (d.cycleSample || 0) + ' MR — فقط آن‌هایی که این ابزار ریویوشان کرده'],
    ['MRهای هنوز باز', d.stillOpenCount == null ? '' : d.stillOpenCount,
      'میانه‌ی سن ' + hoursLabel(d.medianOpenAgeHours) + ' · قدیمی‌ترین ' + hoursLabel(d.oldestOpenHours)],
    ['MRهایی که اصلاً کامنت خورده‌اند (٪)', d.discussedPct == null ? '' : d.discussedPct,
      d.discussedPct === 0
        ? 'هیچ گفت‌وگوی ریویویی در گیت‌لب ثبت نشده، پس «زمان تا اولین ریویو» قابل محاسبه نیست'
        : (d.discussedCount || 0) + ' از ' + (d.discussedSample || 0) + ' MR'],
  ];
  if (sp) {
    rows.push(
      [],
      ['— آخرین اسپرینت —', '', ''],
      ['نام اسپرینت', sp.name, ''],
      ['امتیاز اسپرینت', sp.score == null ? '' : sp.score,
        sp.score == null
          ? 'هنوز چیز قابل‌سنجشی در این اسپرینت نبوده'
          : 'بدون «تکمیل تسک‌ها» حساب شده — اسپرینتِ در جریان هنوز قرار نیست تمام شده باشد'],
      ['تسک‌ها', sp.doneCount + ' از ' + sp.taskCount + ' به Done رسیده', ''],
      ['تسک Review/Done بدون ثبت زمان', sp.noTimeLogged,
        sp.noTimeLogged ? 'این‌ها در بقیه‌ی اعداد سوراخ ایجاد می‌کنند' : '']
    );
  }
  return rows;
}

const SUMMARY_COLUMNS = [{ format: 'text', width: 34 }, { format: 'text', width: 24 }, { format: 'wrap', width: 70 }];

module.exports = { buildMonthlyRows, COLUMNS, GLOSSARY_COLUMNS, SUMMARY_COLUMNS, toSheetRows, glossaryRows, summaryRows, taskMonth, faMonthLabel, columnLetter, latestSprint, sprintSeries };
