// The developer page's task strip groups Jira issues by status. The groups
// are built in the order Jira returned the issues; the strip is ordered by
// where the work sits (in review, in progress, to do, done). Those two orders
// routinely disagree, and a positional index between them paired each heading
// with a different status's cards — the label, the count and the "N without
// time" flag were all correct, only the card list underneath belonged to
// somebody else. Reported as "Done says 9 without time but has one task".
//
// renderJiraTasks lives in public/admin.html rather than in a module, so it is
// lifted out and evaluated here. That is worth the awkwardness: this is the
// only rendering path where a silent mismatch is invisible to every other
// test and, on screen, looks like a data problem rather than a bug.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

function loadRenderer() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
  const fn = src.match(/function renderJiraTasks\(a\) \{[\s\S]*?\n\}\n/);
  assert.ok(fn, 'renderJiraTasks must be findable in admin.html');
  // The column renderer pulls in the facet definitions and the text builder,
  // and all three are part of what this file guards, so they are evaluated
  // together rather than stubbed — a stub would let their real behaviour drift.
  const deps = [
    /const TASK_FACETS = \[[\s\S]*?\n\];/,
    /function facetsPresent\(items\) \{[\s\S]*?\n\}/,
    /function taskLines\(t\) \{[\s\S]*?\n\}/,
    /function taskGroupText\(status, items\) \{[\s\S]*?\n\}/,
  ].map((re) => {
    const m = src.match(re);
    assert.ok(m, 'admin.html must still define ' + re);
    return m[0];
  });

  const sandbox = {
    esc: (x) => String(x == null ? '' : x)
      .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    missingTimeLog: (t) => {
      const reached = t.statusCategory === 'done' || /review/i.test(String(t.status || ''));
      return reached && !(t.spentHours > 0);
    },
    DEV: { taskTab: null, taskFacet: 'all' },
    TASK_TEXT: new Map(),
    faDate: (d) => String(d),
  };
  for (const stub of ['jiraStatusBadge', 'projectBadge', 'mrLinks', 'estimateBadge',
                      'dueBadge', 'ratingBadges', 'renderMonthTabs', 'faDate']) {
    sandbox[stub] = () => '';
  }

  const names = Object.keys(sandbox);
  const make = new Function(...names, deps.join('\n') + '\n' + fn[0] + '\nreturn renderJiraTasks;');
  return { render: make(...names.map((n) => sandbox[n])), sandbox };
}

// Done arrives first from Jira but sorts last in the strip, so the two orders
// disagree — the exact shape that used to mis-pair.
const TASKS = [
  { key: 'D-1', summary: 'done one', status: 'Done', statusCategory: 'done', spentHours: 0, url: 'http://x/D-1' },
  { key: 'R-1', summary: 'rev one', status: 'In Review', statusCategory: 'indeterminate', spentHours: 0, url: 'http://x/R-1' },
  { key: 'R-2', summary: 'rev two', status: 'In Review', statusCategory: 'indeterminate', spentHours: 0, url: 'http://x/R-2' },
  { key: 'R-3', summary: 'rev three', status: 'In Review', statusCategory: 'indeterminate', spentHours: 0, url: 'http://x/R-3' },
];

test('each task tab renders the cards of the status it is labelled with', () => {
  const { render, sandbox } = loadRenderer();

  for (const [tab, expectedLabel, expectedKeys] of [
    ['st0', 'In Review', ['R-1', 'R-2', 'R-3']],
    ['st1', 'Done', ['D-1']],
  ]) {
    sandbox.DEV.taskTab = tab;
    const html = render({ jiraConfigured: true, jiraTasks: TASKS, months: [], jiraTasksTotal: TASKS.length });

    const active = /<button class="htab on" data-tasktab="[^"]*">([^<]*)<span class="htab-count">(\d+)<\/span>/.exec(html);
    assert.ok(active, 'an active tab must be rendered');
    assert.equal(active[1].trim(), expectedLabel);

    // The pill is a link to the ticket now, so it carries an href before the key.
    const keys = [...html.matchAll(/class="task-pill"[^>]*>([A-Z]-\d)\b/g)].map((m) => m[1]);
    assert.deepEqual(keys, expectedKeys,
      `the "${expectedLabel}" tab must show its own tasks, not another status's`);

    // the headline count has to describe the cards actually drawn
    assert.equal(Number(active[2]), keys.length,
      `the "${expectedLabel}" count must match the number of cards below it`);
  }
});

test('the without-time flag counts the tasks on that tab', () => {
  const { render, sandbox } = loadRenderer();
  sandbox.DEV.taskTab = 'st1';                      // Done: one task, no logged time
  const html = render({ jiraConfigured: true, jiraTasks: TASKS, months: [], jiraTasksTotal: TASKS.length });

  const flag = /<button class="htab on"[\s\S]*?<span class="htab-flag"[^>]*>(\d+)/.exec(html);
  const cards = (html.match(/class="task-card[" ]/g) || []).length;
  assert.ok(flag, 'the active tab should carry a without-time flag here');
  assert.ok(Number(flag[1]) <= cards,
    'the flag can never exceed the number of cards on the tab it sits on');
});

// The copy button has exactly the failure mode the tab strip had: it is per
// status, and keying it by anything positional would hand over another
// column's tickets. That is worse than the display bug, because what lands in
// somebody's clipboard leaves the page entirely.
test('each column copies its own tickets and nobody else\'s', () => {
  const { render, sandbox } = loadRenderer();
  sandbox.DEV.taskTab = 'st0';
  const html = render({ jiraConfigured: true, jiraTasks: TASKS, months: [], jiraTasksTotal: TASKS.length });

  const buttons = (html.match(/data-copytasks=/g) || []).length;
  assert.ok(buttons >= 1, 'the rendered column must carry a copy button');

  assert.deepEqual([...sandbox.TASK_TEXT.keys()].sort(), ['Done', 'In Review']);

  for (const [status, text] of sandbox.TASK_TEXT) {
    for (const t of TASKS) {
      if (t.status === status) {
        assert.ok(text.includes(t.key), `${status} text must include its own ${t.key}`);
        assert.ok(text.includes(t.url), `${status} text must include ${t.key}'s link`);
      } else {
        assert.ok(!text.includes(t.key), `${status} text must not leak ${t.key}`);
      }
    }
  }
});

// Reported: a Done column where some tasks have logged time and some do not,
// with nothing separating them in the cards or in the copied text. The facet
// strip and the segmented copy share one definition of the facets, so this
// covers both at once.
const MIXED = [
  { key: 'N-1', summary: 'no time', status: 'Done', statusCategory: 'done', spentHours: 0, hasMr: true, url: 'http://x/N-1' },
  { key: 'N-2', summary: 'no time', status: 'Done', statusCategory: 'done', spentHours: 0, hasMr: true, url: 'http://x/N-2' },
  { key: 'W-1', summary: 'has time', status: 'Done', statusCategory: 'done', spentHours: 3, hasMr: true, url: 'http://x/W-1' },
];

test('a column offers a filter for each facet its tasks actually have', () => {
  const { render, sandbox } = loadRenderer();
  sandbox.DEV.taskTab = 'st0';
  const html = render({ jiraConfigured: true, jiraTasks: MIXED, months: [], jiraTasksTotal: MIXED.length });

  const chips = [...html.matchAll(/data-taskfacet="([^"]+)"[^>]*>[^<]*<span class="facet-n">(\d+)/g)]
    .map((m) => [m[1], Number(m[2])]);
  const byId = Object.fromEntries(chips);

  assert.equal(byId.all, 3);
  assert.equal(byId['no-worklog'], 2);
  assert.equal(byId.worklog, 1);
  // every task here has an MR and none is overdue, so those chips must not
  // appear — a filter that leads to an empty list is worse than no filter
  assert.ok(!('no-mr' in byId), 'a facet with no members must not get a chip');
  assert.ok(!('overdue' in byId), 'a facet with no members must not get a chip');
});

test('the copy is segmented, and follows the filter that is on', () => {
  const { render, sandbox } = loadRenderer();
  sandbox.DEV.taskTab = 'st0';

  sandbox.DEV.taskFacet = 'all';
  render({ jiraConfigured: true, jiraTasks: MIXED, months: [], jiraTasksTotal: MIXED.length });
  const whole = [...sandbox.TASK_TEXT.values()][0];
  assert.match(whole, /## بدون ثبت زمان \(2\)/);
  assert.match(whole, /## با ثبت زمان \(1\)/);
  // each ticket filed once, even though a ticket can match several facets
  for (const t of MIXED) {
    const entries = (whole.match(new RegExp('^' + t.key + ' — ', 'gm')) || []).length;
    assert.equal(entries, 1, `${t.key} must appear exactly once in the copied text`);
  }

  sandbox.DEV.taskFacet = 'no-worklog';
  sandbox.TASK_TEXT.clear();
  const filteredHtml = render({ jiraConfigured: true, jiraTasks: MIXED, months: [], jiraTasksTotal: MIXED.length });
  const filtered = [...sandbox.TASK_TEXT.values()][0];
  assert.ok(filtered.includes('N-1') && filtered.includes('N-2'));
  assert.ok(!filtered.includes('W-1'), 'a filtered column must not copy what it is not showing');
  assert.equal((filteredHtml.match(/class="task-card[" ]/g) || []).length, 2,
    'the cards shown must match what was copied');
});

test('a filter with no members in this column falls back to showing everything', () => {
  const { render, sandbox } = loadRenderer();
  sandbox.DEV.taskTab = 'st0';
  sandbox.DEV.taskFacet = 'overdue';           // nothing here is overdue
  const html = render({ jiraConfigured: true, jiraTasks: MIXED, months: [], jiraTasksTotal: MIXED.length });
  assert.equal((html.match(/class="task-card[" ]/g) || []).length, MIXED.length,
    'an inapplicable filter must not empty the column');
});
