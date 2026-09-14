// Atomic file write: temp file in the same directory + rename, instead of a
// direct writeFileSync onto the real path.
//
// Every file this project keeps on disk (settings, the reviewed/approved
// shas, dev score ratings, the knowledge base, project list, secrets.env,
// activity log, cache files) is read-modify-written as a whole JSON blob or
// text file. A direct writeFileSync is not one filesystem operation — a
// crash or power loss partway through it leaves a truncated file — and
// every reader here (readJson/readAll/JSON.parse) treats invalid JSON the
// same as "nothing was ever written", which silently discards whatever was
// on disk. For most of these that's a slow rebuild; for reviewed.json or
// secrets.env it means re-reviewing every open MR, or the server failing to
// start.
//
// rename() on the same filesystem is atomic on both POSIX and Windows: the
// destination is either the old content or the fully-written new content,
// never a partial write. The temp name includes pid+time so concurrent
// writers (two requests racing on the same file) never collide on it before
// the rename.
const fs = require('fs');
const path = require('path');

// Monotonic within the process, because pid+timestamp is not unique: two
// writes in the same millisecond — two analytics rows landing together and
// both updating the same cache file, which is routine here — produced the
// same temp path, and then one rename moved the file out from under the
// other, which failed with ENOENT on a source that had just been renamed
// away. Seen as an intermittent failure in the Jira cache tests, roughly one
// run in five.
let counter = 0;

// Synchronous sleep. These writes are all on the sync path (state, cache,
// settings), so there is no promise to await here, and Atomics.wait on a
// throwaway buffer parks the thread without burning CPU the way a spin loop
// would.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Windows does not give you a clean atomic replace: renaming onto an existing
// file fails with EPERM/EACCES/EBUSY whenever anything still holds a handle
// to the destination for a moment — a virus scanner reading the file an
// instant after the last write, the search indexer, an editor with it open.
// It clears on its own within a few milliseconds, so a short backoff turns a
// hard failure into a pause nobody notices. Without it this is simply flaky
// on the platform this project actually runs on: a tight loop of writes to
// one file reproduces it within a few dozen iterations.
const RENAME_ATTEMPTS = 10;
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);

function renameWithRetry(tmp, file) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (attempt >= RENAME_ATTEMPTS || !TRANSIENT.has(e.code)) throw e;
      sleepSync(2 + attempt * 3); // ~150ms in total across all attempts
    }
  }
}

function atomicWriteFileSync(file, data) {
  const dir = path.dirname(file);
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.${counter}.tmp`);
  fs.writeFileSync(tmp, data);
  try {
    renameWithRetry(tmp, file);
  } catch (e) {
    // Never leave the temp file behind when the rename genuinely fails: a
    // directory slowly filling with .tmp files is a worse failure than the
    // one that caused it, and harder to trace back to here.
    try { fs.unlinkSync(tmp); } catch (e2) { /* already gone */ }
    throw e;
  }
}

module.exports = { atomicWriteFileSync };
