# ADR-0001: One next-actions read owns the coordination order

## Status

Accepted - 2026-10-24.
Decided in #199, #231, and #233.
Planned, not yet implemented.

## Context

Operator needed a declarative and deterministic process that guided agents and subagents through their workflows.
A session-local schedule could disagree with recorded state and made each agent reconstruct the workflow order and its blockers.
PR ownership and report acceptance needed one answer about what could run next.

## Decision

One read of next actions owns the coordination order.
The same recorded state and observed facts give the same applicable actions and waits.
The CLI reports ready assignments, idle workers with PR actions, reports awaiting acceptance, interrupted workers that need attention, failed cleanup, and ended sources.
Review waits also report the applicable review and Slack transport actions.
Agents invoke the named CLI operations rather than keep a separate schedule or perform the CLI's mechanical steps themselves.

Herdr activity is an observation, not completion evidence.
A stopped or idle worker can require attention without having submitted a report or completed a PR.
The SuperAgent supplies the coordination judgment and obtains the person's decisions when authority is unclear.

## Consequences

- New workflow operations must be reachable through the next actions, or agents cannot discover them through the protocol.
- Maintaining one coordination answer costs explicit rules for both PR and report work and for interrupted workers.
- CLI decisions remain deterministic even though GitHub, Herdr, and Slack observations change over time.

## Alternatives considered

- A queue in the SuperAgent's conversation was rejected because a restart loses it and it can disagree with Operator state.
- Independent command reports that agents combine into a schedule were rejected because the combination becomes a second implementation of workflow order.
- Treating a host completion event as accepted work was rejected because it proves neither a durable report nor a verified merge.

Related: ADR-0003, declarative machines provide the workflow states; ADR-0010, PR owners follow the feedback loop; ADR-0013, report acceptance is distinct from worker activity; ADR-0015, review waits own review operations.
