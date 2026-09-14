// lib/atomicWrite.js — temp file + rename, so a crash mid-write can never
// leave a half-written file that every reader here treats as "nothing was
// ever written".
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { atomicWriteFileSync } = require('../lib/atomicWrite');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-atomic-'));
}

test('the file ends up with the content, and no temp file is left behind', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'settings.json');
  atomicWriteFileSync(file, '{"a":1}');

  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}');
  assert.deepEqual(fs.readdirSync(dir), ['settings.json'], 'nothing but the real file');
});

test('overwriting replaces the content rather than appending to it', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'settings.json');
  atomicWriteFileSync(file, 'first');
  atomicWriteFileSync(file, 'second');

  assert.equal(fs.readFileSync(file, 'utf8'), 'second');
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
});

// The regression: the temp name was pid+timestamp, so two writes inside the
// same millisecond built the *same* path. The first rename moved it away and
// the second failed with ENOENT on a source that no longer existed — which
// showed up as the Jira cache tests failing about one run in five.
test('many writes in the same millisecond do not collide on one temp name', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'cache.json');

  for (let i = 0; i < 500; i++) atomicWriteFileSync(file, 'value ' + i);

  assert.equal(fs.readFileSync(file, 'utf8'), 'value 499', 'the last write wins');
  assert.deepEqual(fs.readdirSync(dir), ['cache.json'], 'and no .tmp survivors');
});

test('two different files in the same directory never share a temp name', () => {
  const dir = tmpDir();
  for (let i = 0; i < 50; i++) {
    atomicWriteFileSync(path.join(dir, `f${i}.json`), String(i));
  }
  const names = fs.readdirSync(dir).sort();
  assert.equal(names.length, 50);
  assert.ok(!names.some((n) => n.endsWith('.tmp')), 'no temp file left over');
  assert.equal(fs.readFileSync(path.join(dir, 'f7.json'), 'utf8'), '7');
});
