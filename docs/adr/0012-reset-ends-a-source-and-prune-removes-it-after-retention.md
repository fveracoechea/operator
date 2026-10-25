# ADR-0012: Reset ends a source and prune removes it after retention

## Status

Accepted - 2026-10-24.
Decided in #207, #231, and #233.
Planned, not yet implemented.

## Context

A person needed to stop one direction of work and register the same origin again without colliding with old records.
Ending a source needed distinct outcomes for completed and incomplete assignments.
An archive would duplicate PR history but would not add a permanent home for report work.

## Decision

A work source has an open lifecycle that ends as finished or reset.
Every registration gets a new source identity, so the same parent issue can start a new source after the earlier one ends.
Only one source of that parent is open at a time.
Reset runs on the person's instruction, not an autonomous SuperAgent choice.

Reset refuses while a worker is running.
It preserves merged PR assignments and completed report assignments, abandons incomplete assignments, and marks the source reset.
It needs no reset grant or plan-approval machine.
It removes no worktree or branch and changes no tracker content.
A finished source accounts for completed reports as well as merged PR work.

Ended sources remain in Operator state until prune deletes their records and device-state files after at least 14 days from their end.
This includes briefs, reports, and supporting files.
There is no source archive.
Prune removes no retained worktree or branch and does not prune migration backups.
Failed cleanup remains visible in next actions.

## Consequences

- Reset preserves incomplete project work but does not keep that work active in the old source.
- Report references expire with the source's retention period even when another project used them.
- Consumers need required report content in their own briefs rather than a permanent dependency on the producer's file path.
- No archive reader or permanent local audit store remains after prune.

## Alternatives considered

- Reusing a source identity was rejected because old resources and new work would collide.
- A reset freeze with filters on every query was rejected because an explicit ended state is harder to omit.
- A separate reset-grant protocol was rejected because the person's instruction authorizes the reset.
- Source archives and indefinite retention were rejected because GitHub keeps PR history and the person accepted bounded report retention.
- Deleting worktrees during reset or prune was rejected because ending records does not establish that project work is safe to delete.

Related: ADR-0003, explicit source lifecycle; ADR-0010, PR completion and cleanup; ADR-0013, report retention and cross-project consumption; ADR-0007, migration backups have separate retention.
