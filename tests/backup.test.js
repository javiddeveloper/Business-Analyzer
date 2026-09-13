// lib/backup.js — data/ is this service's only copy of the score, activity,
// audit and usage history plus secrets.env itself. These tests cover the
// copy actually landing intact, rotation not deleting more than it should,
// and a fresh install (no data/ yet) not erroring.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

function freshBackup({ withData = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-backup-data-'));
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-review-backup-out-'));
  fs.rmdirSync(backupDir); // exists-check in run() should recreate it — start from "doesn't exist yet"
  process.env.CR_DATA_DIR = dataDir;
  process.env.CR_BACKUP_DIR = backupDir;
  if (withData) {
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ a: 1 }));
    fs.writeFileSync(path.join(dataDir, 'ratings.json'), JSON.stringify({ b: 2 }));
  }
  delete require.cache[require.resolve('../lib/backup')];
  return { backup: require('../lib/backup'), dataDir, backupDir };
}

test('run() copies every file in data/ into a new timestamped folder', () => {
  const { backup, backupDir } = freshBackup();
  const result = backup.run();
  assert.ok(result.path && fs.existsSync(result.path));
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.path, 'settings.json'), 'utf8')).a, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.path, 'ratings.json'), 'utf8')).b, 2);

  const listed = backup.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].path, result.path);
});

test('a missing data/ directory is a no-op, not an error', () => {
  const { backup, dataDir } = freshBackup({ withData: false });
  fs.rmSync(dataDir, { recursive: true, force: true }); // simulate "never initialized"
  const result = backup.run();
  assert.ok(result.skipped, 'reports skipped rather than throwing');
  assert.deepEqual(backup.list(), []);
});

test('list() returns newest first', async () => {
  const { backup } = freshBackup();
  backup.run();
  await new Promise((r) => setTimeout(r, 5));
  backup.run();
  const listed = backup.list();
  assert.equal(listed.length, 2);
  assert.ok(listed[0].name > listed[1].name, 'the more recent timestamp name sorts first');
});

test('run() prunes down to `keep`, deleting the oldest first', async () => {
  const { backup } = freshBackup();
  for (let i = 0; i < 5; i++) {
    backup.run({ keep: 3 });
    await new Promise((r) => setTimeout(r, 5)); // distinct timestamps so names actually differ/sort
  }
  const listed = backup.list();
  assert.equal(listed.length, 3, 'only the 3 most recent survive');
});

test('an in-flight atomicWrite temp file is never copied into a backup', () => {
  const { backup, dataDir } = freshBackup();
  fs.writeFileSync(path.join(dataDir, '.settings.json.1234.5678.tmp'), 'garbage');
  const result = backup.run();
  assert.ok(!fs.existsSync(path.join(result.path, '.settings.json.1234.5678.tmp')));
  assert.ok(fs.existsSync(path.join(result.path, 'settings.json')), 'the real file is still copied');
});
