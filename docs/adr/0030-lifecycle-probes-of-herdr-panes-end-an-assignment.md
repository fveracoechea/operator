# ADR-0030: Lifecycle probes of Herdr panes end an assignment

## Status

Accepted - 2026-11-13. Decided in #373 and #380.

## Context

Upgrades and cleanup blocked on assignments whose worker and worktree were gone.
Lost pane events left recorded workers running after Herdr removed their resources.
Ignored build output also blocked cleanup without protecting project work.

## Decision

A worktree assignment ends when its worker and worktree are both gone.
A pane assignment ends when its pane is gone.
Source reset and next actions ask Herdr whether a pane is live, because recorded events can be missing.
`operator abandon` ends one assignment without deleting resources or closing its PR.
An ended PR-open assignment retains its open PR reference for adoption.

Ignored entries never count as unlanded work, except changed environment files.
Migration guards retain live-process protections rather than blocking on assignment state alone.
Readiness stays static under ADR-0009; lifecycle probes do not change its scope.
A parked assignment keeps its worktree, so this end rule does not end it.

## Consequences

- Next actions require a Herdr read for each running launch.
- Ending an assignment does not establish completion or authorize disposal of retained project work.
- Missing event delivery no longer requires a source-wide reset to retire one assignment.

## Alternatives considered

- A project allow-list for ignored files adds policy maintenance for generated output.
- Abandoning assignments during an upgrade loses active workflow meaning without a lifecycle observation.

Related: ADR-0009, static readiness; ADR-0012, source reset and retention.
