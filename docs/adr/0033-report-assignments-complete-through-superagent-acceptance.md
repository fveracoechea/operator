# ADR-0033: Report assignments complete through SuperAgent acceptance

## Status

Accepted - 2026-10-24.
Decided in #233.
Supersedes ADR-0006 and ADR-0019.
Planned, not yet implemented.

## Context

SuperAgents delegated investigation, research, triage, planning, and prototypes as well as code.
A PR-only assignment could not represent their completion without inventing a branch or treating host activity as evidence.
The former planning-record machinery also assigned human authority too broadly or made every planning question wait on the person.

## Decision

One assignment model has explicit PR and report completion types rather than a record for every task kind.
Report assignments move through ready, running, reported, and completed, or end as abandoned.
A WorkerAgent submits a durable report through the CLI with a short conclusion, evidence references, unresolved points, and supporting files available by reference.
Herdr activity or a completion event proves neither submission nor acceptance.

The supervising SuperAgent accepts the report or returns specific follow-up instructions.
Submission alone does not unblock dependencies.
Returned work resumes as running when the worker resumes.
A stopped or failed worker leaves its incomplete work available for replacement, with the brief, earlier reports, and follow-up instructions preserved.
Next actions show reports awaiting acceptance and workers needing attention after failure or interruption.
A report dependency waits for completed, while PR dependencies keep their PR-open or merged rule.

Assignment instructions determine grilling participation and the SuperAgent's decision authority.
A SuperAgent answer remains a SuperAgent decision, including after report acceptance.
If the person asks to answer, if a question is outside delegated authority, or if authority or participation is unclear, the SuperAgent asks the person.
This includes high-level product and architecture decisions with unclear authority.
Reports and instructions carry the distinction without restoring question, approval, or planning-record machines.

Reports and supporting files live in device state.
Acceptance permits automatic pane closure, but a report worktree stays unless the CLI can establish that it holds no unlanded work.
Only the person can authorize deletion of unlanded work.
Read-only report work has no worktree to remove.

SuperAgents exchange accepted report references through Herdr for cross-project use.
The receiving SuperAgent places needed content and its source reference in the consumer's brief.
There is no cross-project dependency engine.
Reset preserves completed reports and abandons incomplete ones, and source prune deletes reports after the source's 14-day retention period.

## Consequences

- One model needs completion-type-specific transitions and dependency guards.
- Report completion costs an explicit SuperAgent acceptance step rather than worker self-acceptance.
- Replacement preserves evidence but cannot restore unrecorded reasoning from a stopped conversation.
- Cross-project coordination is explicit, and a consumer cannot rely only on an expiring producer path.
- Report cleanup may retain a worktree after its pane closes.

## Alternatives considered

- A PR for every delegated task and separate assignment models for each task kind were rejected because non-code work needs neither a forced PR nor a new scheduler for each method.
- Worker self-acceptance and completion from host activity were rejected because neither supplies independent acceptance of durable evidence.
- Requiring the person to answer every grilling question was rejected because instructions can delegate authority.
- Inferring unclear authority was rejected because acceptance must not turn a supervisor decision into a human answer.
- Restoring planning records and approval machines was rejected because the report and instruction contract covers this exchange.
- A cross-project dependency engine and indefinite retention were rejected in favor of Herdr coordination and consumer-owned brief content.

Related: ADR-0006 and ADR-0019, historical authority and planning protocols; ADR-0011, reports and interruptions appear in next actions; ADR-0023, completion-type-specific transitions; ADR-0030, PR completion remains separate; ADR-0031, briefs and resource selection; ADR-0032, reset and retention; ADR-0034, profiles and native subagents; ADR-0037, supervision boundary.
