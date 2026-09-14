<!--
Sync Impact Report
- Version change: (none) → 1.0.0 (initial ratification)
- Modified principles: n/a (new document)
- Added sections: Core Principles (I–VI), Additional Constraints, Development Workflow, Governance
- Removed sections: n/a
- Templates requiring follow-up: none — no prior versioned constitution existed to reconcile against.
- Deferred TODOs: RATIFICATION_DATE set to the date this document was first authored (no earlier
  ratified version exists to backdate to).
-->

# Coder Review Constitution

## Core Principles

### I. Zero Heavy Dependencies
The service runs on plain Node.js with no framework and no database — storage is flat
JSON files on disk. New functionality MUST NOT introduce an npm dependency (runtime or
the admin dashboard's client-side code) unless there is no reasonable way to implement it
in vanilla Node/browser JS. Any exception MUST be justified in the PR description: what
was tried without the dependency, and why it was insufficient.
**Rationale**: this is the project's stated identity (`README.md`) and the reason it can be
deployed with `npm install && npm start` and no DevOps team. Every dependency is a future
supply-chain and maintenance liability the project has deliberately opted out of.

### II. Deterministic Checks Are Separate From Model Judgment
Findings that come from a fixed pattern (hardcoded credentials, debug output, missing
tests, oversized MRs) MUST be produced by deterministic code (`lib/checks.js`-style logic),
never left to chance on whether the model happens to notice them, and MUST be labeled in
the report as distinct from model-sourced findings. Code paths that make an AI model's
output silently override or gate a deterministic check, or that let a model's judgment
masquerade as a human's, are a CRITICAL defect.
**Rationale**: credential leaks and similar are exactly the failures that must not depend
on an LLM "seeing it this time." Conflating model opinion with fact-based checks — or with
human sign-off — was identified as the project's most serious real defect (`BUSINESS-REVIEW.md`
§3.1: an AI-generated rating silently overwrote a maintainer's committed rating and fed
directly into a person's performance score).

### III. Everything Skipped or Uncertain Is Reported, Never Silent
Any file, finding, or context that was dropped due to a size cap, an unparseable diff
line, a filtered file type, or an unreachable engine MUST be named explicitly in the
output shown to the user — never merged into an unqualified "reviewed" state. A finding
whose line could not be verified against the diff MUST be marked as unverified rather than
posted as if confirmed.
**Rationale**: this project's central trust claim is that a clean report is a real claim
("seen, nothing found"), not silence. Every place this already holds (batch caps, rejected
files, context truncation, engine fallbacks) must keep holding as the code grows.

### IV. Human Authority Over Consequential Decisions
The service MAY auto-approve a merge request when review is clean and merge-order rules
are satisfied, but MUST NEVER merge, and MUST NEVER let an automatically generated score
or rating stand in for a human's explicit judgment where that judgment has organizational
or personnel consequences. Any score derived even partly from AI output MUST be visibly
tagged as such and MUST NOT silently substitute for a maintainer-authored value already on
record.
**Rationale**: "Approve yes, merge never" is an explicit, named product decision. The
developer-scoring system exists to inform conversation, not to adjudicate people — treating
it otherwise is called out as the project's primary organizational risk.

### V. Regression Coverage Is Part of the Change, and Must Be Deterministic
A change to review logic, scoring, persistence, or webhook/polling behavior MUST come with
or update tests in `tests/`, runnable via `npm test` with no network access and no reliance
on any engine-specific or machine-specific `secrets.env` value. A test that only passes
because of the *particular* AI engine or context-window configuration active on one
machine is a bug in the test, not an acceptable regression baseline.
**Rationale**: the project's credibility rests on its test suite (171 tests at last count,
covering worktree isolation, concurrent MR handling, cancellation, atomic-write races, and
more). A suite that is green on one machine and red on another because it silently reads
live local configuration cannot function as CI and must be treated as a defect, not a
known quirk.

### VI. Fail Closed on Missing Security Configuration
Where a security control depends on optional configuration (e.g. `ADMIN_TOKEN`), the
absence of that configuration MUST cause the service to fall back to its *most* restrictive
safe behavior (e.g. binding to `127.0.0.1` only), never to an implicitly-trusted signal
that a reverse proxy or other deployment change can silently defeat (e.g. trusting
`req.socket.remoteAddress === '127.0.0.1'` behind a proxy). Secrets and tokens MUST NOT be
logged, and token comparisons MUST use timing-safe comparison where feasible.
**Rationale**: the IP-based localhost check is documented as sound for a single laptop and
silently unsound the moment the service sits behind any reverse proxy — exactly the kind of
deployment change that happens without anyone touching this code.

## Additional Constraints

- **Persistence**: writes to the JSON data store (`data/`, `cache.js`, `state.js`) MUST be
  atomic (write-to-temp-then-rename) wherever a partial write would corrupt state that
  drives user-visible behavior (e.g. `reviewed.json`, rating/activity history). A cache file
  that may be safely rebuilt from scratch is exempt but should say so in a comment.
- **Scope of automation**: the service posts comments and may auto-approve; it MUST NOT
  write to application source files, and MUST NOT perform any destructive git operation
  (force-push, hard reset, branch deletion) on a user's repository under any configuration.
- **Cost visibility**: any new AI-engine call path MUST contribute its token usage to a
  place the existing/planned usage accounting can read, rather than being invisible to it.

## Development Workflow

- Every PR/change touching `lib/` or `server.js` MUST be checked against the Core
  Principles above before merge; a violation of a MUST principle is the highest-severity
  review finding and blocks merge until resolved or explicitly, visibly deferred.
- Documentation (`README.md`) MUST be updated in the same change when it would otherwise
  drift from the code it describes (caps, counts, behavior) — stale docs have already been
  identified as a recurring defect in this project.
- Complexity (a new dependency, a new persistent file format, a new background loop) MUST
  be justified in the PR description against Principle I and Principle III.

## Governance

This constitution supersedes ad-hoc practice for this repository. Amendments require:
1. A documented rationale (what changed and why) recorded in a Sync Impact Report at the
   top of this file at amendment time.
2. A version bump following semantic versioning: MAJOR for incompatible governance or
   principle removal/redefinition, MINOR for a new principle or materially expanded
   guidance, PATCH for clarification or wording fixes.
3. Review of any dependent templates/commands that reference a changed principle.

All reviews (human or `/code-review`-style automated review) of changes to this codebase
MUST verify compliance with the Core Principles. Any exception MUST be stated explicitly in
the PR, not left implicit.

**Version**: 1.0.0 | **Ratified**: 2026-09-14 | **Last Amended**: 2026-09-14
