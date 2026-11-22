# ADR-0010: PR assignments own their feedback loop and merge

## Status

Amended 2026-11-17 in #422: an owner can refresh open prerequisites and use a per-child dependency-only integration base.
Amended 2026-11-21 in [#422](https://github.com/fveracoechea/operator/issues/422#issuecomment-7067082891): all prerequisite consumers use the complete graph, including parked observations.

Accepted - 2026-10-24.
Amended 2026-11-21: optional commit completion is separate and changes no PR approval guard (ADR-0034).
Decided in #228, #231, #232, and #233.
Implemented: the feedback loop in #249, stacked starts and parent-merge relay in #250, the guarded merge and cleanup in #251, and the optional reviewer through `review.assignments` in #253.
Amended 2026-11-04 in #305: the merge also requires that an internal review of the PR ended ready or was skipped (ADR-0020).
Amended 2026-11-04 in #320: the guarded merge uses GitHub's asynchronous merge endpoint, because the synchronous endpoint refuses a stacked PR.
Amended 2026-11-17 in #389: a fresh pr-feedback launch takes over at ready, and the merge requires the recorded ready transition.
Amended 2026-11-18 in #390: quiet feedback waits park the assignment and changes resume a fresh launch.
Amended 2026-11-20 in #392: the supervisor may merge parked work on the person's instruction, and a queue retains parking until observed merge.
Amended 2026-11-21 in [#414's approved scope](https://github.com/fveracoechea/operator/issues/414#issuecomment-7067082608): source holds, durable direct recovery, and mandatory correction evidence retain parked-only selection.

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
A fresh pr-feedback launch takes over at the ready transition, checks bot and human claims, replies, and pushes fixes.
The CLI waits for the next applicable action, including new review feedback, failing CI, merge eligibility, and a merged parent that requires rebasing.
A quiet wait parks the assignment and ends its launch, except while checks run on the worker's pushed head.
Parking keeps the worktree and PR-open state, not a live worker.
Only a note supplied to the parking wait is retained for the next launch; the reviewer's earlier note is not a park note.
Coordination waits read all parked PRs in one batch every 15 minutes, using a durable device-wide schedule and observation cursors.
Quiet and repeated reads wake nothing.
New feedback, failing CI, newly observed merge eligibility, or a merged parent produces `resume_pr_feedback` and a fresh launch with durable events.
Merge eligibility remains an observation, not permission to bypass the merge gate.
An interrupted resume keeps those events for its replacement through the ordinary recorded handoff and launch machinery.
A verified merge ends the assignment and runs cleanup.
A close without merge produces `clean_up` with `pr_closed`, whose next command abandons the assignment without deleting unlanded work.

A dependency with an open or merged PR permits dependent code work to start.
The child PR stacks on the parent's branch, and the CLI coordinates the relay and rebase after the parent merges.
A PR uses a prerequisite branch that contains its required heads, or a per-child dependency-only integration base when no prerequisite contains the others.
The owner can bind implemented sibling prerequisites through audited stack records without rewriting the registered plan.
The CLI pins the old prerequisite cut and the replacement heads before it changes the child.
It refuses ambiguous attribution rather than replay obsolete prerequisite history or discard child work.
Only the child owner changes the child's refs and PR base; prerequisite owners retain their refs and worktrees.
Interrupted effects retain their pinned inputs and uncertain outcomes until inspection establishes which effects completed.
A stacked PR is not merge eligible until every required prerequisite merged into the default branch and its relay finished.
Parked observations retain one actionable all-prerequisites event with their cursors; the first merged prerequisite cannot trigger a premature relay.
Report dependencies instead require accepted completion.
The PR owner invokes the CLI merge operation, or the supervising SuperAgent selects a parked assignment on the person's instruction.
It refuses unless the PR has approval, passing checks, no unresolved threads, the default branch as its base, and no draft state.
ADR-0020 added the draft condition, implemented in #316.
It also requires the assignment's recorded ready transition, because an ended review or an external draft change alone cannot prove that transition.
It merges through GitHub's asynchronous merge endpoint as a direct merge pinned to the guarded head, because the synchronous endpoint refuses a PR that GitHub keeps in a stack, also after its relay.
That endpoint also merges a stacked PR's open PRs below it, and the default branch base rules them out.
It is used for every non-queue PR, not only after the synchronous endpoint refuses, because GitHub does not document that refusal's text.
The cost is a merge that can wait up to two minutes of status reads.
When the PR's base requires a merge queue, the same passed gate enqueues the guarded head instead of requesting a direct merge.
Observed queue membership prevents a retry from enqueueing the same PR again, including after a lost response.
Enqueueing proves no completion. The assignment stays PR-open and parked, with its worktree retained, until a batch read verifies its merge.
GitHub CI and GitHub reviews are the gates, not a separate local gate declaration or a supervisor's claim.

An open merge hold blocks new delivery across its source, regardless of an optional PR reference.
Hold creation and new delivery admission exclude each other.
An accepted request or queue entry can still apply, so a later hold cannot claim to stop it.
Direct delivery retains its original actor, guarded head, readiness provenance, and remote request identity beyond process exit or owner replacement.
Recovery reads the original request; an uncertain request without an identity cannot be blindly resubmitted.
Observation of an already applied merge needs neither new approval nor absence of a later hold.
Cleanup still independently protects unlanded work.

After a changed known ready head, the current feedback owner must record exact-head correction scope and targeted evidence.
That evidence belongs to the current readiness provenance, not a launch or a broad review round.
It survives parking and replacement, but cannot satisfy GitHub approval or a fresh integration review.
Readiness with an unknown migration head keeps its accepted compatibility without an invented baseline.

After verified merge, the CLI deletes the remote branch, closes the worker pane, and removes the worktree in that order without a separate approval grant.
Failed cleanup remains visible in next actions.
Unlanded work remains protected, and only the person can authorize its deletion.
An optional reviewer is off by default and uses a separate review request whose comments do not approve the owner's PR.

Report assignments have a separate completion contract and support planning and other non-PR work.

## Consequences

- Dependent code can start before its parent merges, so the workflow must handle changed parent branches and rebases.
- The first feedback launch and replacements receive recorded review findings, dispositions, the summary link, and the optional reviewer note.
- CI becomes the mechanical quality source, so a repository with weak CI receives no replacement local gate from Operator.
- Agents retain tracker-update responsibility outside the workflow CLI.
- Automatic cleanup follows verified completion, so failures need durable visibility instead of a second approval protocol.

## Alternatives considered

- A source-wide integration branch and separate publication stack remain rejected because they add another delivery lifecycle.
  Per-child dependency-only bases are accepted because a child can need independent open prerequisites without modifying their owners' branches.
- Fresh workers for every correction remain unnecessary within a live launch; parking accepts a cold start in exchange for releasing a quiet worker.
- Waiting for parent merge before any dependent starts was rejected in favor of PR stacking and explicit rebase handling.
- Supervisor-written scripts and ledgers were rejected because the CLI must own the repeatable feedback, merge, and cleanup steps.
- Retaining tracker recovery, write-path scheduling, and local gates was rejected because the sessions did not need them and existing tracker tools, Git conflicts, and CI already covered the retained work.
- A blanket ban on agent merges was rejected in favor of a guarded merge by the owner WorkerAgent or the instructed supervisor of parked work.

Related: ADR-0001 and ADR-0003, deterministic coordination; ADR-0012, reset and prune; ADR-0013, report completion and safe cleanup; ADR-0015, optional review requests; ADR-0016, mutation analysis does not join the gate; ADR-0017, worker ownership and guarded merge.
