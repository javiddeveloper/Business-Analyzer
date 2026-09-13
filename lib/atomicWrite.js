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

function atomicWriteFileSync(file, data) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

module.exports = { atomicWriteFileSync };
