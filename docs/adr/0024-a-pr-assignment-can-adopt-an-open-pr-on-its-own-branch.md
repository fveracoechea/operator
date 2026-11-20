# ADR-0024: A PR assignment can adopt an open PR on its own branch

## Status

Accepted - 2026-11-11.
Amended 2026-11-20: adoption accepts one-off PR or branch selectors and legal entry kinds, as decided in #373 and #395.
Decided for finding 2 of the SuperAgent retro of 2026-11-11.
Amends ADR-0011: explicit adoption can use an existing remote branch, but local-only work and checked-out worktrees still block the start.
Amends ADR-0020: a ready adopted PR gets no internal review, also when the assignment, the plan, or the device turns it on.

## Context

A SuperAgent often had to carry a PR that Operator did not open: one the person started, one from an earlier session, or one whose owner was gone.
Dispatch skips every taken local or remote branch, and associate finds a PR only by the worker's own branch, so no WorkerAgent could own such a PR.
In the retro sessions the SuperAgent ran native subagents in hand-made worktrees instead, and those subagents edited PR bodies and pushed with no feedback loop, no guarded merge, and no record in `next`.
One case had uncommitted, half-done fixes in a worktree of the PR branch.

## Decision

A PR assignment can name an open PR in the plan with `adopt` and the PR's number, beside the PR's head branch as its `branch`.
One-off dispatch also accepts `--adopt <pr-number|pr-url|branch>`, under the same ownership and entry rules.
A branch without an open PR enters `implementation`.
A draft PR enters `implementation` or `review`; a ready PR enters `implementation` or `pr-feedback`.
Report kinds cannot adopt work.
A plan adopts each PR at most once.
Registration stays offline. Dispatch reads the PR at each start until its owner associates it.

Dispatch refuses a PR that is not open, belongs to another author, or comes from another repository, including a fork.
A planned PR must also use its planned branch.
Another author's PR belongs in a review request, because adoption grants push ownership.
A live assignment or open review request that owns the PR or branch blocks adoption.
The adopted branch is recorded directly, without generating a new-work branch name.
It then fetches the branch and puts the local branch at the PR head before Herdr creates the worktree, because Herdr checks out an existing branch as it is:
a missing local branch is created to track the remote branch, and a branch behind the PR head moves forward.
It refuses and names the work when the local branch has commits that the PR lacks, or when a worktree has the branch checked out, with a separate reason when that worktree has uncommitted changes.
Operator never overwrites, adopts, or removes that work. The person or the SuperAgent lands it or moves it, then dispatches again.
A replacement before the association reopens the recorded worktree and skips the branch checks, because the branch is then its own.

The adopted assignment keeps the normal lifecycle.
The owner's brief names the PR and tells it to read its reviews, comments, unresolved threads, and checks before changing code or waiting.
It preserves existing commits and opens no second PR.
Facts from an ended PR-open owner accompany the new brief: intent, issue, rounds, dispositions, and the summary comment link.
Those facts provide history, not approval or a new readiness receipt.
Ready adoption records association and readiness before the worker starts, without an outgoing-worker handoff.
Direct draft adoption into `review` records the association and starts its reviewer without an implementer handoff.
Both direct entries retain the association's base check.
An adopted draft entering `implementation` keeps the normal associate operation.

### Internal review of an adopted PR

A PR that is ready for review when dispatch reads it gets no internal review: the launch records internal review as off, whatever the plan or the device says.
A ready PR is already in front of reviewers, and the internal review exists to run before that point.
Turning it back to a draft would hide it from people who already review it, and an approval or thread that exists stays valid only on a ready PR.
A draft keeps the resolved setting, so with internal review on, its owner works as the implementer and the association hands the draft to a fresh reviewer.
Direct entry into `review` starts that reviewer instead of another implementer.
With it off, the owner marks the draft ready before its first wait, because the merge gate needs a ready PR.

## Consequences

- An adopted PR's owner starts without the author's context, so it relies on the PR, its threads, and the code.
- A ready adopted PR reaches the merge gate with the person's review only, as with internal review turned off.
- A PR marked ready between dispatch and associate is refused by associate as not a draft. A replacement then reads it as ready.
- After a verified merge, cleanup deletes the remote branch and the local branch, also when someone else created them.
- Dispatch verifies both the PR and its authenticated author before adoption.

## Alternatives considered

- A separate adopt command was rejected because it would be a second way to start a PR assignment outside the registered plan, and next actions, the running cap, and replacements already follow the plan.
- Opening an existing worktree of the branch was rejected because it may be the controlling checkout or hold the person's work, and cleanup would later remove it.
- Deferring every association to the incoming worker was rejected for direct review and ready entry, because their phase guards require an associated PR.
- Internal review of every adopted PR, by converting it to a draft, was rejected because it hides a PR that people already review.
- Checking the PR at registration was rejected because registration reads no remote service, and the PR can change before dispatch.

Related: ADR-0010, the PR feedback loop and merge gate; ADR-0011, worktree names and briefs; ADR-0020, internal review of a draft PR.
