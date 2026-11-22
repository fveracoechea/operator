# ADR-0034: Commit delivery is a separate completion contract

## Status

Accepted - 2026-11-21. Decided in #411.
Amends ADR-0003, ADR-0006, ADR-0010, ADR-0013, ADR-0020, and ADR-0029.

## Context

Personal projects needed one ticket commit on local and remote main without a pull request.
PR approval remained mandatory for PR assignments.
Removing that approval from another completion contract also removed the independent check of a reviewer's final fixes.
A squash tree did not prove that intermediate implementation history was safe to delete.

## Decision

Commit delivery is an explicit completion type for new assignments.
PR delivery remains the default implementation contract.
Existing assignments, adoptions and promotions keep their completion type.
A kind cannot override completion or hand work to a different completion type.

Commit work uses an isolated ticket worktree and a fresh reviewer launch.
The reviewer receives recorded target facts, task and intent, without an implementer note.
At most two rounds apply.
Every finding needs a disposition.
An applied blocker requires a later clean review.
An applied blocker in the second round stops automatic delivery instead of removing that guard.

The delivery target and policy belong to the assignment.
Configured checks qualify one exact candidate, base, tree and policy.
The target commit is nonempty, has one parent, preserves the reviewed tree and names the ticket.
Git's configured identity, signing and hooks remain authoritative.

Completion requires verified local and remote delivery.
Dependents wait for completion rather than stacking on an unlanded candidate.
A dirty or unsupported target checkout cannot authorize delivery.
Concurrent advancement never authorizes force-pushing or overwriting work.

Candidate creation, checkout/index transition, local advancement, publication and finalization have separate durable evidence.
There is no atomic transaction across Git, files, SQLite and the remote.
Recovery observes partial effects and retries the pinned candidate.
An uncertain push does not prove failure.

Intermediate history and unlanded work remain retained without the person's deletion authority.
Tree equality alone never authorizes branch deletion.

## Consequences

- A failed publication can leave a local commit that is not completed work.
- Remote protection can stop automatic delivery after local advancement.
- Exhausted review requires a person decision while retaining the ticket's work.
- Completed tickets can retain worktrees and intermediate branches.

## Alternatives considered

- Reusing PR completion would invent PR facts or weaken approval.
- Accepted reports would prove acceptance rather than delivery.
- Automatically rebasing a pinned candidate would invalidate its review and checks.
- Deleting a squashed branch would discard history without ancestry proof.

Related: ADR-0006, cross-system effects; ADR-0020, fresh review; ADR-0029, fixed completion and closed guards.
