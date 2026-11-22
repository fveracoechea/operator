# Commit-delivery compatibility

Commit delivery is opt-in for new source assignments.
Existing PR and report assignments keep their completion contracts.
The default implementation kind still completes through a PR.
Existing PR approval, readiness, CI and merge gates remain in effect.
ADR-0034 records the separate commit contract.

## Stored state

Migration `0029_commit_delivery` adds one assignment-keyed evidence table.
It changes no existing assignment, kind, PR, report, handoff or readiness record.
The fixed migration has an additive blocker policy.
Future upgrades wait for unresolved commit-delivery effects, even after their process ends.
Normal startup uses the existing compatibility and backup checks.

The source decoder refuses completed commit assignments without delivery evidence.
It checks the repository, assignment, policy, ticket and implementer relationship.
The delivery record checks review, configured checks and completion receipts against the pinned candidate.
Finalization updates assignment and source completion in one SQLite transaction.
Git, checkout files and remote publication remain separate effects.

## Executable evidence

- `src/modules/device-state/schema.test.ts` checks the shipped migration against the declared schema.
- `src/modules/device-state/migration-policy.test.ts` checks migration prefixes and unresolved commit effects.
- `src/modules/operator-cli/run.compatibility.test.ts` checks skipped releases, backups and historical state.
- `src/modules/work-sources/snapshot.test.ts` refuses a completion flag without delivery evidence.
- `src/modules/operator-cli/run.pull-request-guards.test.ts` deliberately breaks existing PR guards.
- `src/modules/operator-cli/run.commit-delivery.test.ts` runs real Git and SQLite through disposable CLI fixtures.
- `src/modules/commit-delivery/main.test.ts` checks partial publication, failed receipts, checkout refusals and configured Git behavior.
- `src/modules/work-sources/main.commit.test.ts` retains commit evidence beyond normal source pruning.

The public CLI scenario kills delivery after checkout/index, local ref and remote publication effects.
Retries reuse the recorded candidate.
The installed workflow suite runs that scenario through isolated source and registry installations.
Both installation paths passed locally.
The registry is a local fixture, not a publication.
No installed device runtime changed.

The Quality workflow discovers these tests through its existing shards.
The Release smoke workflow runs the installed workflow suite.
No remote CI run is claimed by this document.

## Qualification limits

Feature qualification is not complete.
The changed-production mutation run reported surviving mutants and stopped at a failed baseline.
A narrower run also reported survivors in the new decision, storage and command units.
These results are not an accepted mutation waiver.
The external implementation evidence records exact commands, logs and outstanding work.
Full quality and fresh independent review remain delivery gates.
