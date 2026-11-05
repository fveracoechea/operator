# ADR-0006: One device database holds Operator state

## Status

Accepted - 2026-10-24.
Decided in #204, #208, #231, and #232.
Implemented in #240, with automatic compatibility in #245.
Amended 2026-11-04: a plan can cap its own running assignments, and the device still has no agent quota.
The running cap is implemented in #318.

## Context

Project records needed to share identity and workflow observations across clones on one device.
Separate stores could not give a consistent view of related assignments and dependencies.
One database also increased the scope of corruption and migration failures.

## Decision

One SQLite database holds Operator state for every registered project, with Drizzle as the schema and migration integration.
The first explicit project registration creates it atomically.
Unrelated commands do not create or repair a missing database.
Project identity scopes source records, and dependent records reach their project through their source.
Briefs and larger supporting content remain device-state files, not separate workflow databases.

Each mutation uses one immediate transaction, and reads use a consistent snapshot.
Writes across projects serialize, but no external tool or network call runs while a state transaction holds the write lock.
A busy timeout produces a definite failure rather than a partial write.
SQLite uses full synchronization explicitly.

A damaged database is never silently repaired or replaced.
Commands refuse and identify the last verified backup.
Backups are consistent SQLite snapshots verified for integrity and migration history, not copies of live database side files.
Compatibility uses the applied migration history, not an independent integer version.
The config-write lock and receipt remain outside the database so a settings operation does not hold workflow writes.

State guards reject a second transition.
SuperAgents choose parallel work without a device-wide agent quota.
A plan can set an optional running cap.
While the plan's assignments with a starting or live worker reach that cap, next actions list no ready assignment of that plan and dispatch refuses one.
The cap counts PR owners in their feedback loop and internal reviewers, because each holds a pane, a worktree, and CI runs.
The cap is part of the registered plan and changes only with a new registration.

## Consequences

- One damaged file stops every project, and one migration moves every project.
- Concurrent projects wait briefly for each other's writes, which is accepted because transactions contain no external work.
- Snapshot reads and atomic creation need explicit tests, not only schema type checks.
- Backups are only as recent as the last migration because Operator has no periodic backup service.
- A capped plan can leave ready work idle while the device has room for it, and a long PR feedback loop holds a slot that new work could use.
  The person accepted that cost to protect CI minutes and the device on a large plan.

## Alternatives considered

- One database per project or feature was rejected because cross-record reads and project identity need one consistent device view.
- Silent table creation on every open was rejected because it can conceal damaged or unsupported state.
- Raw copies of a live database and its side files were rejected because they do not establish a consistent backup.
- An integer version beside migration history was rejected because two format authorities can disagree.
- Supervisor ownership and request-replay protocols were rejected because transition guards protect the workflow from duplicate operations.
- A device-wide agent quota in device settings was rejected because one project's large plan would starve another project's work, and SuperAgents of different projects would compete for one count.
- A cap that only the SuperAgent remembers was rejected because a restart loses it and next actions would list work that the cap forbids.
- Counting only implementers, without PR owners and reviewers, was rejected because those agents use the same device and CI.

Related: ADR-0001, next actions apply the running cap; ADR-0004, device settings and state ownership; ADR-0005, registration creates project identity; ADR-0007, automatic compatibility and verified migration backups; ADR-0003, state guards own transitions; ADR-0009, static readiness does not replace integrity protection; ADR-0019, core Result boundaries without unthrown's database integration.
