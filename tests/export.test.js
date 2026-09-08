// The Excel export: the monthly rows behind it (lib/monthly.js) and the
// zero-dependency .xlsx writer (lib/xlsx.js).
//
// The xlsx tests read the file back out of the ZIP rather than trusting that
// build() returned something — a workbook that doesn't open is the failure
// mode that matters, and it looks exactly like success from the inside.
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const monthly = require('../lib/monthly');
const xlsx = require('../lib/xlsx');

// ---- xlsx ------------------------------------------------------------------

// Minimal ZIP reader: walks the central directory and inflates each entry,
// which is exactly what Excel does, so anything it can't read here Excel
// can't read either.
function unzip(buf) {
  const files = {};
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(eocd, -1, 'no end-of-central-directory record — not a ZIP at all');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central directory entry header');
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');

    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    files[name] = zlib.inflateRawSync(buf.slice(dataStart, dataStart + compSize)).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

test('build() produces a readable ZIP with every part a workbook needs', () => {
  const buf = xlsx.build([{ name: 'برگه', rows: [['ماه', 'امتیاز'], ['2026-08', 58]] }]);
  const files = unzip(buf);
  for (const required of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) {
    assert.ok(files[required], `missing part: ${required}`);
  }
  assert.match(files['xl/worksheets/sheet1.xml'], /<t xml:space="preserve">2026-08<\/t>/, 'strings are written inline');
  assert.match(files['xl/worksheets/sheet1.xml'], /<v>58<\/v>/, 'numbers stay numeric, not stringified');
  assert.match(files['xl/workbook.xml'], /name="برگه"/, 'the sheet keeps its Persian name');
  assert.ok(!files['xl/worksheets/sheet1.xml'].includes('<drawing'), 'no chart requested, no dangling drawing reference');
});

test('a sheet with a chart carries the drawing and chart parts that make it live', () => {
  const buf = xlsx.build([{
    name: 'برگه', rows: [['ماه', 'امتیاز', 'MR'], ['2026-08', 58, 13], ['2026-09', 45, 7]],
    chart: { title: 'روند', categoryCol: 'A', series: [{ col: 'B' }, { col: 'C' }] },
  }]);
  const files = unzip(buf);
  assert.ok(files['xl/charts/chart1.xml'], 'the chart part exists');
  assert.ok(files['xl/drawings/drawing1.xml']);
  assert.ok(files['xl/worksheets/_rels/sheet1.xml.rels'], 'the sheet points at its drawing');
  assert.ok(files['xl/drawings/_rels/drawing1.xml.rels'], 'the drawing points at its chart');
  assert.match(files['[Content_Types].xml'], /chart\+xml/, 'declared, or Excel refuses the whole file');

  // The series must reference real cells; a chart pointing at the wrong
  // range opens fine and shows nothing, which is worse than not opening.
  const chart = files['xl/charts/chart1.xml'];
  assert.match(chart, /'برگه'!\$B\$2:\$B\$3/);
  assert.match(chart, /'برگه'!\$C\$2:\$C\$3/);
  assert.match(chart, /'برگه'!\$A\$2:\$A\$3/, 'categories come from the month column');
});

test('control characters are stripped, since one would make Excel reject the file', () => {
  const dirty = 'a\u0007b\u0000c'; // a bell and a NUL, both illegal in XML 1.0
  const files = unzip(xlsx.build([{ name: 'S', rows: [[dirty], ['ok']] }]));
  const sheet = files['xl/worksheets/sheet1.xml'];
  assert.match(sheet, /<t xml:space="preserve">abc<\/t>/, 'the text survives, the control bytes do not');
  assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(sheet), 'no illegal byte anywhere in the part');

  // And ordinary XML escaping still has to hold.
  const escaped = unzip(xlsx.build([{ name: 'S', rows: [['a & b <c>'], ['ok']] }]));
  assert.match(escaped['xl/worksheets/sheet1.xml'], /a &amp; b &lt;c&gt;/);
});

test('colName maps past Z the way spreadsheet columns actually run', () => {
  assert.equal(xlsx.colName(0), 'A');
  assert.equal(xlsx.colName(25), 'Z');
  assert.equal(xlsx.colName(26), 'AA');
  assert.equal(xlsx.colName(27), 'AB');
});

// ---- monthly rows -----------------------------------------------------------

const TASK = (over) => ({ statusCategory: 'done', estimateHours: null, spentHours: null, resolvedAt: null, updated: null, dueDate: null, ...over });

test('a task lands in the month it was finished, not the month it was created', () => {
  assert.equal(monthly.taskMonth({ resolvedAt: '2026-08-30T00:00:00Z', updated: '2026-09-02T00:00:00Z' }), '2026-08');
  assert.equal(monthly.taskMonth({ resolvedAt: null, updated: '2026-09-02T00:00:00Z' }), '2026-09', 'unfinished work counts in the month it last moved');
  assert.equal(monthly.taskMonth({ resolvedAt: null, updated: null }), null);
});

test('monthly rows carry the GitLab counts and the Jira totals for each month', () => {
  const rows = monthly.buildMonthlyRows({
    analytics: { months: [{ month: '2026-08', mrCount: 13, roundTripCount: 2, noReportCount: 9 }] },
    jiraTasks: [
      TASK({ resolvedAt: '2026-08-10T00:00:00Z', estimateHours: 10, spentHours: 12 }),
      TASK({ resolvedAt: '2026-08-20T00:00:00Z', estimateHours: 6, spentHours: null }),
      TASK({ resolvedAt: '2026-08-25T00:00:00Z', statusCategory: 'indeterminate', estimateHours: null, spentHours: 4 }),
    ],
    reviews: [],
    now: Date.parse('2026-09-08T00:00:00Z'),
  });

  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.month, '2026-08');
  assert.equal(r.mrCount, 13);
  assert.equal(r.roundTripCount, 2);
  assert.equal(r.taskCount, 3);
  assert.equal(r.doneCount, 2);
  assert.equal(r.estimateHours, 16, 'sum of every recorded estimate');
  assert.equal(r.spentHours, 16, 'sum of every recorded worklog');
});

// Regression: the totals summed all tasks while the drift used only tasks
// with both numbers, so a month could read "125h estimated, 22h spent, 0%
// drift" — three numbers that cannot all be true, and a reader would rightly
// stop trusting the sheet.
test('drift is measured only where both numbers exist, and says how many tasks that was', () => {
  const rows = monthly.buildMonthlyRows({
    analytics: { months: [{ month: '2026-07', mrCount: 0, roundTripCount: 0, noReportCount: 0 }] },
    jiraTasks: [
      TASK({ resolvedAt: '2026-07-05T00:00:00Z', estimateHours: 10, spentHours: 20 }), // +100%
      TASK({ resolvedAt: '2026-07-06T00:00:00Z', estimateHours: 100, spentHours: null }), // no worklog
    ],
    reviews: [],
    now: Date.parse('2026-09-08T00:00:00Z'),
  });
  const r = rows[0];
  assert.equal(r.estimateDriftPct, 100, 'measured on the one task that has both, not on the 110h total');
  assert.equal(r.driftBasis, 1, 'and the sheet says it rests on a single task');
  assert.equal(r.estimateHours, 110);
  assert.equal(r.spentHours, 20);
});

test('a month with nothing to score reports no score rather than a zero', () => {
  const rows = monthly.buildMonthlyRows({
    analytics: { months: [{ month: '2026-01', mrCount: 1, roundTripCount: 0, noReportCount: 1 }] },
    jiraTasks: [], reviews: [], now: Date.parse('2026-09-08T00:00:00Z'),
  });
  assert.equal(rows[0].score, null);
});

test('toSheetRows puts the labels first and lines every row up under them', () => {
  const rows = monthly.buildMonthlyRows({
    analytics: { months: [{ month: '2026-08', mrCount: 2, roundTripCount: 0, noReportCount: 0 }] },
    jiraTasks: [TASK({ resolvedAt: '2026-08-01T00:00:00Z', estimateHours: 4, spentHours: 4 })],
    reviews: [], now: Date.parse('2026-09-08T00:00:00Z'),
  });
  const sheet = monthly.toSheetRows(rows);
  assert.equal(sheet[0][0], 'ماه');
  assert.equal(sheet[0].length, monthly.COLUMNS.length);
  assert.equal(sheet[1].length, monthly.COLUMNS.length, 'every data row matches the header width');
  assert.equal(sheet[1][0], '2026-08');
});
