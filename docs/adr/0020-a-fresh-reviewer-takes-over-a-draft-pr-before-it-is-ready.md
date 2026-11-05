# ADR-0020: A fresh reviewer takes over a draft PR before it is ready

## Status

Accepted - 2026-10-31.
Decided in #292.
Adds a draft condition to the ADR-0010 merge gate and moves the start of the ADR-0015 assignment reviewer to the ready transition.
Amended 2026-11-04 in #305 with the answers to its open questions, below.

## Context

A PR owner went from finished work straight to a PR that was ready for review.
The only reviews came after that point, from the person at the merge gate and from the optional assignment reviewer, which posts its findings as a GitHub comment.
No fresh reader checked the work against its issue, the repository standards, and the skills that its brief named before other people saw it.
A SuperAgent could ask for such a review only in free-text task instructions, and nothing enforced that request.
The person wanted a fresh, adversarial reviewer on by default, which applies the valid findings itself, with a way to skip it for urgent work.

## Decision

### The reviewer takes over the assignment

When internal review applies, the implementer opens its PR as a draft and records it with the associate operation.
That operation ends the implementer's session and starts the reviewer as the next launch of the same PR assignment, in the assignment's recorded worktree.
The implementer is not needed after the draft exists, because its work is in the pushed branch and the reviewer applies all later changes.
The associate operation refuses a worktree with uncommitted or unpushed changes, so the handoff leaves no unlanded work behind.
One worktree with one live agent avoids two writers in one checkout, and it avoids a second worktree and its preparation for every PR.

The reviewer is the PR owner from the handoff to the merge.
It reviews, applies the valid findings, pushes to the same draft, moves the PR to ready, and then runs the PR feedback loop and the guarded merge.
This is one planned owner change for each PR, not a fresh worker for each correction.

The CLI starts the reviewer, because the CLI owns agent launch and the implementer cannot start a WorkerAgent that the SuperAgent supervises.
The reviewer is a WorkerAgent under the same SuperAgent, and a failed or interrupted start appears in next actions like every other launch.

### The reviewer's inputs

The reviewer brief is a variant of the assignment brief.
It gives the tracker issue, the assignment instructions, the PR, its base, and the commit and push rules of a PR owner.
The assignment instructions are the SuperAgent's statement of intent and named skills, so they carry no account by the implementer.
The reviewer loads those named skills, because it both judges conformance to them and writes code under them.
It does not receive the implementer's conversation, any implementer summary, or the PR body as evidence.
Operator keeps coordination files in device state, so the worktree carries no implementer notes.

### Rounds and the end of the loop

A round is one review of the whole PR diff against its base at a recorded head, followed by the fixes for its valid findings.
The reviewer records each round's findings and reviewed head with the CLI before it changes code.
It checks three axes: Spec against the issue, Standards against documented standards, repository patterns, and the person's opinions, and Skills against each skill that the instructions name.
The Skills axis lives in the review procedure of the owned worker skill, while the upstream code-review skill stays unchanged and supplies Spec and Standards.

A round with a blocker requires a second round at a newer head, so the reviewer's own fixes get a review.
A fresh native subagent does that second review with the same inputs and without the first round's reasoning.
A request has at most two rounds.
The loop ends after a round with no blocker, or after the fixes of the second round.
The person's merge approval stays the final independent check of every change, including the reviewer's fixes.

### Ready and the summary comment

The reviewer moves the PR to ready through a guarded CLI operation, not by a direct GitHub call.
That operation refuses until every recorded round is complete, every finding has a disposition, and the worktree head is pushed and equals the PR head.
It posts one summary comment, marks the PR ready, and records the ready head.
The comment states each finding and how it was applied, or why the reviewer declined it.
The reviewer writes its text to the person's writing rules, and the CLI checks that every recorded finding appears in it.
Declined findings appear in that comment, not in the PR body, because the comment is the one public trace of the internal review and the body stays an account of the change.
No line-level threads or other review comments are posted.

### Lifecycle and gates

The internal review is a separate lifecycle of a PR assignment, owned by the module that owns PR associate, ready, and merge.
It moves through reviewing, with at most two rounds, and ends ready or skipped.
The assignment's own states do not change, and a draft PR counts as open.
Dependents can start on a draft parent, because they already start on an open PR that feedback still changes, and stacked PRs already follow parent changes.

The merge gate refuses a draft PR, and it refuses an assignment whose internal review has not ended ready or skipped.
The gate sits at merge as well as at the ready operation, because a person or an agent can mark a draft ready outside Operator, and every PR passes through the merge.
The PR wait reports a draft's feedback and checks to the reviewer, and it never reports merge eligibility for a draft.

### Opt-out

Internal review is on by default.
A device setting supplies the default, a plan can turn it off or on for all its assignments, and an assignment can turn it off or on for itself.
The most specific value wins: assignment, then plan, then device.
Each launch resolves and records the value, so a running owner keeps it and a replacement resolves it again.
When it is off, the implementer opens a ready PR, keeps ownership as before, and no reviewer starts.
On the person's instruction, the SuperAgent can skip a running internal review, which ends it and marks the PR ready with no summary comment.

### Relation to the assignment reviewer

The assignment reviewer stays a separate, optional review request that posts a comment after the PR is ready.
When internal review applies, that request starts at the ready transition instead of at associate, so it reviews the PR that people see.

### Rollout

The procedure first ships as skill text and a brief change.
In that phase the SuperAgent ends the implementer's pane and dispatches the replacement owner as the reviewer, the reviewer marks the PR ready and comments with GitHub's own tools, and the two-round limit and the comment content are instructions.
The CLI handoff, round records, guarded ready operation, and merge gate replace those instructions once the procedure has run on real PRs, and the skill text then shrinks to the commands.

### Answers to the open questions of #305

The evidence is the accepted review of 36 phase 1 PRs in two repositories, from 2026-10-31 to 2026-11-04.

1. Operator never merges a draft PR. The merge gate refuses a draft whatever GitHub does, so GitHub's handling of an approval or a merge of a draft needs no probe. This is the person's decision. No phase 1 PR had an approval or a merge while it was a draft.
2. The association starts the handoff as its own process group from the controlling checkout, as a merge starts its cleanup. That process waits for the associate process to end, closes the implementer's pane, ends the implementer launch as finished, and dispatches the reviewer. A failed or stopped handoff shows as `retry_handoff`, and `operator handoff` repeats it from the step where it stopped. A failed reviewer start shows as `replace_worker`.
3. A launch records only its resolved internal review value, a launch-time resolution under ADR-0014. The implementer and the reviewer are steps of the review, not worker roles: the review record names the implementer launch, and a later launch of a running review is its reviewer. Only a start before the PR exists resolves the value again, so a settings change cannot drop a review that already started.
4. A round with an applied blocker requires a second round. 24 of 35 reviewed PRs had a round 1 blocker, round 2 found something new in 21 of them and a new blocker in 8, and the one PR that declined every round 1 blocker still moved its head. Each recorded finding carries its severity, so the ready step can check this rule.
5. The CLI renders one line for each recorded finding, with its axis, severity, and disposition, and checks that every finding appears once. The reviewer writes only a short overview. 14 of 33 phase 1 comments left out declined findings that their round files recorded, none marked severity, and 2 PRs went ready with no comment.
6. The SuperAgent skips a running review with a person-instructed command from the controlling checkout, as it resets a source or deletes unlanded work. The one phase 1 skip was a person's instruction that the SuperAgent relayed to the worker through Herdr, and ADR-0022 removes typed text as a channel. A SuperAgent command records the skip without a message to the reviewer, which keeps the PR as its owner and learns of the skip when its next review command refuses.
7. The brief reads the reviewer step from the recorded review, never from the draft state. A launch of a running review is its reviewer, and a launch after the review ended is the PR owner, whose brief names the end and the ready head. `next` treats that launch as any PR owner. In phase 1, a replacement after ready acted as owner only because it read the draft state.
8. Phase 2 ships as two slices: the lifecycle, its records, the handoff, and the rounds first, then the ready step, the merge gate, and the summary comment.

## Consequences

- Every PR with internal review on costs a second agent session and a cold start in a prepared worktree.
- The PR owner after the review has the reviewer's context, not the implementer's, so feedback answers rely on the code, the issue, and the comment rather than the implementer's reasoning.
- GitHub shows a draft PR before the review ends, so watchers and CI see work before it is reviewed, but no line-level comments appear.
- The reviewer checks code that it wrote, so the second round's fresh subagent and the person's approval carry the independent check of those fixes.
- The two-round limit can leave a declined or open finding, which the summary comment shows to the person rather than a third round.
- During the skill-only phase, the handoff looked like an interrupted worker in next actions, and the limits were not enforced. The CLI handoff shows it as a wait, and the round command enforces the round limits.
- An associate that runs before the work is finished ends the implementer's session, so association means that the implementer is done.

## Alternatives considered

- A native subagent of the implementer was rejected because it shares the implementer's context and cannot be a fresh reader.
- A reviewer in its own worktree that pushes to the PR branch was rejected because it needs a second prepared worktree for every PR, a reviewer branch that Operator pushes, and an idle implementer that must later pull the reviewer's commits.
- Keeping the implementer as owner after the review was rejected because two agents would then need a protocol for who may push, and the implementer has no part in the review.
- Findings that the implementer applies were replaced by the person's decision that the reviewer applies them.
- A review request with an internal origin was rejected because review requests never change the PR branch, while this reviewer owns it.
- A review before any PR exists, gated at associate, was replaced by the draft PR, because the draft supplies a stable head, CI, and the existing PR wait.
- Declined findings in the PR body were rejected because the body describes the change, and a check on it would need to parse prose that the owner edits.
- Holding dependents until the draft is ready was rejected because dependents already start on an open PR that feedback still changes.

Related: ADR-0003, the internal-review lifecycle; ADR-0010, the PR owner, the merge gate, and stacked starts; ADR-0011, the reviewer reopens the recorded worktree; ADR-0013, a replacement keeps unlanded work; ADR-0014, launch-time resolution; ADR-0015, the assignment reviewer starts at ready; ADR-0017, the reviewer is a WorkerAgent under the same SuperAgent.
