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

  const sandbox = {
    esc: (x) => String(x == null ? '' : x)
      .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    missingTimeLog: (t) => {
      const reached = t.statusCategory === 'done' || /review/i.test(String(t.status || ''));
      return reached && !(t.spentHours > 0);
    },
    DEV: { taskTab: null },
  };
  for (const stub of ['jiraStatusBadge', 'projectBadge', 'mrLinks', 'estimateBadge',
                      'dueBadge', 'ratingBadges', 'renderMonthTabs', 'faDate']) {
    sandbox[stub] = () => '';
  }

  const names = Object.keys(sandbox);
  const make = new Function(...names, fn[0] + '\nreturn renderJiraTasks;');
  return { render: make(...names.map((n) => sandbox[n])), sandbox };
}

// Done arrives first from Jira but sorts last in the strip, so the two orders
// disagree — the exact shape that used to mis-pair.
const TASKS = [
  { key: 'D-1', summary: 'done one', status: 'Done', statusCategory: 'done', spentHours: 0, url: '#' },
  { key: 'R-1', summary: 'rev one', status: 'In Review', statusCategory: 'indeterminate', spentHours: 0, url: '#' },
  { key: 'R-2', summary: 'rev two', status: 'In Review', statusCategory: 'indeterminate', spentHours: 0, url: '#' },
  { key: 'R-3', summary: 'rev three', status: 'In Review', statusCategory: 'indeterminate', spentHours: 0, url: '#' },
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

    const keys = [...html.matchAll(/task-pill">([A-Z]-\d)</g)].map((m) => m[1]);
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
