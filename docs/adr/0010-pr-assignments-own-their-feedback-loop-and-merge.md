# ADR-0010: PR assignments own their feedback loop and merge

## Status

Accepted - 2026-10-24.
Decided in #228, #231, #232, and #233.
Partly implemented: the feedback loop in #249, the guarded merge and cleanup in #251. Parent-merge relay and the optional reviewer are planned.

## Context

Real sessions used Herdr, GitHub reviews, and CI to deliver code.
They repeatedly rebuilt feedback routing, PR-stack handling, merge checks, and cleanup by hand.
Assigning each correction to a fresh worker would lose the owner's working context.

## Decision

Operator is a thin, deterministic workflow CLI over Herdr.
The SuperAgent reads the tracker through its existing tools and supplies a plan of assignments, dependencies, and tracker keys.
The CLI does not read or mutate tracker issues and has no tracker recovery layer.
Closing keywords handle GitHub issue completion, while agents use the tracker's own CLI for other tracker updates.
Canonical-map amendment remains an agent convention, not a tracker state machine.

Each PR assignment owns one PR and follows the lifecycle ready, running, PR open, and merged, with abandoned as an incomplete end.
Its owner WorkerAgent carries it through bot and human feedback, checks each claim, replies, and pushes fixes.
The CLI waits for the next applicable action, including new review feedback, failing CI, merge eligibility, and a merged parent that requires rebasing.
A wait timeout makes an idle owner visible to the SuperAgent for replacement rather than proving completion.

A dependency with an open or merged PR permits dependent code work to start.
The child PR stacks on the parent's branch, and the CLI coordinates the relay and rebase after the parent merges.
Report dependencies instead require accepted completion.
The PR owner invokes the CLI merge operation.
It refuses unless the PR has approval, passing checks, no unresolved threads, and the default branch as its base.
GitHub CI and GitHub reviews are the gates, not a separate local gate declaration or a supervisor's claim.

After verified merge, the CLI deletes the remote branch, closes the worker pane, and removes the worktree in that order without a separate approval grant.
Failed cleanup remains visible in next actions.
Unlanded work remains protected, and only the person can authorize its deletion.
An optional reviewer is off by default and uses a separate review request whose comments do not approve the owner's PR.

Report assignments have a separate completion contract and support planning and other non-PR work.

## Consequences

- Dependent code can start before its parent merges, so the workflow must handle changed parent branches and rebases.
- Owners retain context through feedback, but a stopped owner still needs replacement from recorded work.
- CI becomes the mechanical quality source, so a repository with weak CI receives no replacement local gate from Operator.
- Agents retain tracker-update responsibility outside the workflow CLI.
- Automatic cleanup follows verified completion, so failures need durable visibility instead of a second approval protocol.

## Alternatives considered

- A source-wide integration branch and separate publication stack were rejected because agent-owned PRs already supplied the observed delivery workflow with less machinery.
- Fresh workers for every correction were rejected because the PR owner already holds the working context and can answer feedback directly.
- Waiting for parent merge before any dependent starts was rejected in favor of PR stacking and explicit rebase handling.
- Supervisor-written scripts and ledgers were rejected because the CLI must own the repeatable feedback, merge, and cleanup steps.
- Retaining tracker recovery, write-path scheduling, and local gates was rejected because the sessions did not need them and existing tracker tools, Git conflicts, and CI already covered the retained work.
- A blanket ban on agent merges was rejected in favor of a guarded merge by the owner WorkerAgent.

Related: ADR-0001 and ADR-0003, deterministic coordination; ADR-0012, reset and prune; ADR-0013, report completion and safe cleanup; ADR-0015, optional review requests; ADR-0016, mutation analysis does not join the gate; ADR-0017, worker ownership and guarded merge.
