// The stable id for one finding, shared by whatever posts it and whatever
// tracks it afterwards.
//
// Split out of publish.js on its own: publish.js also does network calls
// (posting to GitLab), so tests that only care about the review pipeline
// stub the whole module down to `{ publish() {...} }`. jobs.js needs the
// fingerprint to tag every finding for feedback.js (lib/feedback.js) — pulling
// it from publish.js would mean every one of those stubs has to keep this
// export in sync by hand, and quietly breaks (a crash, not a wrong id) the
// moment one of them doesn't.
const crypto = require('crypto');

function fingerprint(finding) {
  const basis = [
    finding.file || '-',
    finding.line == null ? '-' : finding.line,
    (finding.title || '').trim().toLowerCase().slice(0, 120),
  ].join('|');
  return crypto.createHash('sha1').update(basis).digest('hex').slice(0, 12);
}

module.exports = { fingerprint };
