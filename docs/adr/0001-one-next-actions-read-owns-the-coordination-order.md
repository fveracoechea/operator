# ADR-0001: One next-actions read owns the coordination order

## Status

Accepted - 2026-10-24.
Decided in #199, #231, and #233.
Implemented in #244, and later slices add their actions and waits to the same read.
Amended 2026-11-11: the same read lists each source's open obligations beside its actions, without counting them as actions (ADR-0026).
Amended 2026-11-20: assignment rows keep ten actions independent of worker kinds, and every row names its next step (ADR-0031). Decided in #373 and #393.
Amended 2026-11-20: the coordination wait owns review upkeep and review events, replacing the separate review wait. Decided in #373 and #394.

## Context

Operator needed a declarative and deterministic process that guided agents and subagents through their workflows.
A session-local schedule could disagree with recorded state and made each agent reconstruct the workflow order and its blockers.
PR ownership and report acceptance needed one answer about what could run next.

## Decision

One read of next actions owns the coordination order.
The same recorded state and observed facts give the same applicable actions and waits.
The CLI reports ready assignments, questions, reports awaiting acceptance, parked PR changes, interrupted workers, worker attention, cleanup, person decisions, waits, and ended assignments.
The coordination wait also runs review upkeep and reports new review actions and events with their next steps.
Operator has no Slack transport.
Agents invoke the named CLI operations rather than keep a separate schedule or perform the CLI's mechanical steps themselves.

Assignment rows keep these ten actions because worker kinds govern work inside a launch, not the SuperAgent's decisions:

| Action | Reasons |
| --- | --- |
| `ready_assignment` | `assignment_ready` |
| `answer_question` | `question_open` |
| `review_report` | `report_submitted` |
| `resume_pr_feedback` | `pr_feedback`, `ci_failed`, `pr_relay_blocked` |
| `replace_worker` | `launch_failed`, `launch_abandoned`, `worker_interrupted`, `handoff_failed` |
| `worker_attention` | `worker_idle`, `follow_up_returned` |
| `person_decision` | `cleanup_unlanded_work`, `cleanup_resource_mismatch`, `question_awaiting_person` |
| `clean_up` | `cleanup_failed`, `cleanup_stopped`, `pr_closed` |
| `wait` | `launch_starting`, `kind_handoff`, `assignment_active`, `dependencies_pending`, `running_cap_reached`, `cleanup_running`, `pr_parked` |
| `ended` | `assignment_ended` |

Every next-action row carries `next`, which names a command or the decider and question (ADR-0031).
Review request, message, and source rows remain outside this assignment action set.
Obligations remain in `owed`, outside all action sets (ADR-0026).
A new kind adds no action.
A stopped PR wait without a live worker requires a replacement with `worker_interrupted`.
A failed handoff requires a replacement with `handoff_failed`.
A PR closed without merge requires `clean_up` with `pr_closed`, without a person stop.
Unlanded work still requires the person's decision before deletion.

Herdr activity is an observation, not completion evidence.
A stopped or idle worker can require attention without having submitted a report or completed a PR.
The SuperAgent supplies the coordination judgment and obtains the person's decisions when authority is unclear.

## Consequences

- New workflow operations must be reachable through the next actions, or agents cannot discover them through the protocol.
- Maintaining one coordination answer costs explicit rules for both PR and report work and for interrupted workers.
- Renamed actions need no state migration. Each scope's first wait returns renamed rows once under their new action keys.
- CLI decisions remain deterministic even though GitHub, Herdr, and Slack observations change over time.

## Alternatives considered

- A queue in the SuperAgent's conversation was rejected because a restart loses it and it can disagree with Operator state.
- Independent command reports that agents combine into a schedule were rejected because the combination becomes a second implementation of workflow order.
- Treating a host completion event as accepted work was rejected because it proves neither a durable report nor a verified merge.
- Per-kind coordination actions were rejected because they make the SuperAgent reconstruct each worker's phases.

Related: ADR-0003, declarative machines provide the workflow states; ADR-0010, PR owners follow the feedback loop; ADR-0013, report acceptance is distinct from worker activity; ADR-0015, review requests own review operations; ADR-0006, next actions apply a plan's running cap; ADR-0022, the SuperAgent's coordination wait returns this read; ADR-0028, the wait returns only its new actions.
