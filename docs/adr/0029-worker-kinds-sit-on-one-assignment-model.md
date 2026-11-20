# ADR-0029: Worker kinds sit on one assignment model

## Status

Accepted - 2026-11-13. Decided in #373.
Amends ADR-0003, ADR-0013, ADR-0017, and ADR-0020.
The kind and data decision lands in #382; the phase decision lands in #383.
Later tickets supply kind transitions and parking.
Amended 2026-11-17: draft association starts the recorded kind handoff; dispatch recovers failed or stopped handoffs.
Amended 2026-11-19: each assignment permits at most two report returns, including replacement launches, then requires the person's decision.
Amended 2026-11-17 in #389: explicit readiness replaces inferred review or wait evidence and starts the feedback handoff.
Amended 2026-11-18 in #390: parking retains an optional park-only note and durable waking events.
Amended 2026-11-18 in #391: the release maps in-flight PR records and retains explicit migration provenance for unknown historical facts.

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
The release maps in-flight PR assignments from recorded facts only, without a GitHub read.
Reports, unassociated adopted PRs, ended assignments, and cleanup-only records keep a null kind.
Registered plans and historical launch snapshots do not change.
A remaining null kind is filled by its next dispatch, atomically with launch reservation.
An existing kind cannot be replaced through that path.
Migration-origin readiness and parking retain unknown heads as unknown, without inventing historical checks or comments.
A migration receipt alone authorizes neither a merge nor concurrent ownership.
A later release ends the fill path with a blocker for open assignments that still have a null kind.
That later blocker is not part of this release.

One worker-phase machine runs every kind.
The code owns the report and PR tails, their bounded loops, and the closed guard catalog.
A kind declares only the work phases before its tail.
Each work phase names its goal and may name a catalog exit guard.
The closed catalog contains `report_submitted`, `pr_associated`, `round_recorded`, `pr_ready`, `worktree_clean`, and `pr_merged`.
The closing command refuses while its required facts are false and names the next action.
Worker results name the launch's kind, phase, and next action.

The report tail submits a report and awaits acceptance.
A return reopens only report submission, preserves the earlier reports, and requires a fresh submission before acceptance.
An assignment permits at most two report returns across all its launches, so replacing a worker does not restart the loop.
A third return refuses and preserves the work while asking the person whether to accept the report, abandon the assignment, or start a new assignment.
The report-return limit is independent of the PR review-round limit.
The PR tail associates a PR, records at most two review rounds, becomes ready, handles feedback, and ends at merge or park.
Report acceptance and the PR merge gate remain separate lifecycle decisions.
The readiness guard requires an explicit recorded ready transition.
Ready association without internal review records that transition under the clean-worktree and pushed-head guards.
Neither an ended review nor an eligible wait observation substitutes for readiness.
An ended review stays in feedback after a newer head, without reopening review rounds or the ready step.
The canonical merge lifecycle gathers the current GitHub and local facts once.
Observing an associated PR does not require a historical eligibility receipt or a clean worktree.
An already merged PR takes verification and cleanup, without requesting a new merge.
A new merge requires both a recorded ready frontier and the fresh merge gate.
The explicit ready transition proves that frontier, also after a newer head.
A skip records permission only; the reviewer still runs guarded ready without rounds or a summary comment.
The phase machine also checks current worktree cleanliness.
Cleanup independently retains unlanded work until the person authorizes its removal.

For unguarded work, the phase in a result names the command frontier: the last declared work phase before the tail.
It does not claim that earlier reasoning is complete.
The ordered work phases and their goals remain part of the kind snapshot and guide-directed work.
For example, a prototype result can name `react` while its worker still builds.
No host activity, arbitrary question answer, or report submission proves a reaction occurred.
This convention preserves free work without a manual phase-advance command or another progress record.
A handoff changes kinds inside one assignment and links only kinds with the same completion type.
The outgoing worker's closing command starts it, and the next launch follows the recorded next kind.
A running handoff is a wait; a failed or stopped handoff needs a replacement worker, not a separate recovery command.
Draft association with internal review starts the fresh review launch in the same worktree.
The fresh reviewer reads no implementer note.
Ready ends the reviewer and starts fresh pr-feedback through the same recorded handoff and recovery rules.
Its first launch and replacements receive complete dispositions and the optional reviewer note.
At a quiet feedback wait, the same outgoing-launch machinery ends the launch without starting its successor.
Checks running on the worker's pushed head instead keep the wait frontier.
Parking retains a distinct optional note only when the wait parks.
A later resume starts the recorded feedback kind and renders the retained events and park note, including on replacement after failure.
The device records one 15-minute batch-read schedule across coordination waits.
Observation cursors and waking events commit together; a quiet or repeated observation adds no action.
The durable contract can land before activation, but does not by itself enable parking or a batch reader.
Managed-stack activation and the combined #422/#393/#394 action and wait contracts remain a later compatibility obligation; parking uses recorded PR association and parent facts, not invented stack history.

## Consequences

- A new kind of work needs a kind definition before its first dispatch.
- Kind guides delegate work methods to upstream skills without duplicating their procedures.
- Adding a kind does not add an assignment model or a next-action identifier.
- Remaining null kinds require an explicit selection instead of a general fallback.
- Unguarded work has a deterministic command frontier, not observed reasoning progress.
- Exhausting report returns requires the person's decision without automatically abandoning the assignment or deleting its work.

## Alternatives considered

- Separate records per task would duplicate scheduling and completion rules.
- A free-form `general` default would let new work avoid an explicit kind contract.
- A machine per kind would duplicate guards and effects.
- Built-ins in code and custom kinds in another format would create two validation contracts.
- Kind definitions in skill frontmatter would couple workflow data to host-specific skill parsing.
- A read-only step command or manual advancement record would add a second protocol for free work.

Related: ADR-0003, lifecycle machines; ADR-0013, one assignment model and two completion types; ADR-0014, launch snapshots; ADR-0017, worker kinds are not roles; ADR-0020, fresh review.
