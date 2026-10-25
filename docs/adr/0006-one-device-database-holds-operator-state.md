# ADR-0006: One device database holds Operator state

## Status

Accepted - 2026-10-24.
Decided in #204, #208, #231, and #232.
Planned, not yet implemented.

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

## Consequences

- One damaged file stops every project, and one migration moves every project.
- Concurrent projects wait briefly for each other's writes, which is accepted because transactions contain no external work.
- Snapshot reads and atomic creation need explicit tests, not only schema type checks.
- Backups are only as recent as the last migration because Operator has no periodic backup service.

## Alternatives considered

- One database per project or feature was rejected because cross-record reads and project identity need one consistent device view.
- Silent table creation on every open was rejected because it can conceal damaged or unsupported state.
- Raw copies of a live database and its side files were rejected because they do not establish a consistent backup.
- An integer version beside migration history was rejected because two format authorities can disagree.
- Supervisor ownership and request-replay protocols were rejected because transition guards protect the workflow from duplicate operations.

Related: ADR-0004, device settings and state ownership; ADR-0005, registration creates project identity; ADR-0007, automatic compatibility and verified migration backups; ADR-0003, state guards own transitions; ADR-0009, static readiness does not replace integrity protection.
