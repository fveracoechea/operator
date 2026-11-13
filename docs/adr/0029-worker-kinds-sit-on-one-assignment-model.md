# ADR-0029: Worker kinds sit on one assignment model

## Status

Accepted - 2026-11-13. Decided in #373.
Amends ADR-0003, ADR-0013, ADR-0017, and ADR-0020.
The kind and data decision lands in #382; the phase decision lands in #383.
Later tickets supply kind transitions and parking.

## Context

One assignment model ran every task the same way.
SuperAgents pasted protocol into briefs, and a PR owner held a worker until merge.
Research, implementation, and review needed distinct work phases without separate assignment models or worker roles.

## Decision

An assignment carries a worker kind with named work phases, one kind guide, one completion type, default resources, a default start profile, a next kind, and `readsNote`.
Resources and the start profile can be overridden, but the kind fixes the completion type.
Tools remain part of the start profile and host configuration, not the kind.
The built-in kinds are `research`, `answer`, `prototype`, `implementation`, `review`, and `pr-feedback`.
`review` and `pr-feedback` start through transitions or adoption, not plain dispatch.
Review of another author's PR remains a review request.

Built-in and person-defined kinds use one data format.
Person-defined kinds live beside start profiles in device settings and require validation before use.
Every launch records a resolved kind snapshot, so settings changes cannot change a running worker.
A record from before kinds has a null kind until a later launch names one.

One worker-phase machine runs every kind.
The code owns the report and PR tails, their bounded loops, and the closed guard catalog.
A kind declares only the work phases before its tail.
Each work phase names its goal and may name a catalog exit guard.
The closed catalog contains `report_submitted`, `pr_associated`, `round_recorded`, `pr_ready`, `worktree_clean`, and `pr_merged`.
The closing command refuses while its required facts are false and names the next action.
Worker results name the launch's kind, phase, and next action.

The report tail submits a report and awaits acceptance.
A return reopens only report submission, preserves the earlier reports, and requires a fresh submission before acceptance.
The spec calls both loops bounded but specifies no numeric report-return limit or exhaustion action.
No numeric report-return limit is inferred from the PR limit.
The PR tail associates a PR, records at most two review rounds, becomes ready, handles feedback, and ends at merge or park.
Report acceptance and the PR merge gate remain separate lifecycle decisions.
Before explicit ready-transition records exist, a compatibility adapter requires recorded readiness evidence for the same head.
It uses a ready or skipped review, or an eligible-head observation that passed the non-draft and merge checks.
Association without internal review does not itself prove readiness.
Missing or stale evidence remains unknown and sends the owner to its PR wait.
An ended review stays in feedback after a newer head, without reopening review rounds or the ready step.
The final merge gate still refreshes its independent live checks.

For unguarded work, the phase in a result names the command frontier: the last declared work phase before the tail.
It does not claim that earlier reasoning is complete.
The ordered work phases and their goals remain part of the kind snapshot and guide-directed work.
For example, a prototype result can name `react` while its worker still builds.
No host activity, arbitrary question answer, or report submission proves a reaction occurred.
This convention preserves free work without a manual phase-advance command or another progress record.
A handoff changes kinds inside one assignment and links only kinds with the same completion type.
The fresh reviewer reads no implementer note.

## Consequences

- A new kind of work needs a kind definition before its first dispatch.
- Kind guides delegate work methods to upstream skills without duplicating their procedures.
- Adding a kind does not add an assignment model or a next-action identifier.
- Null kinds preserve old records without guessing the worker's task from its completion type.
- Unguarded work has a deterministic command frontier, not observed reasoning progress.
- A numeric report-return cap remains unspecified and requires a separate decision before enforcement.

## Alternatives considered

- Separate records per task would duplicate scheduling and completion rules.
- A free-form `general` default would let new work avoid an explicit kind contract.
- A machine per kind would duplicate guards and effects.
- Built-ins in code and custom kinds in another format would create two validation contracts.
- Kind definitions in skill frontmatter would couple workflow data to host-specific skill parsing.
- A read-only step command or manual advancement record would add a second protocol for free work.

Related: ADR-0003, lifecycle machines; ADR-0013, one assignment model and two completion types; ADR-0014, launch snapshots; ADR-0017, worker kinds are not roles; ADR-0020, fresh review.
