# Rework is a delegated cycle, and a reached limit or a found defect blocks acceptance

`operator work rework` delegates one correction round on one submitted result.
The cycle is registered against the producer assignment, never against the review, so the assignment returns to the frontier and the accepted corrections reach a fresh Operative through the ordinary claim and dispatch path.
The reviewer that found the problem never repairs it, and the Operator holds no worktree of its own, so neither of them can be the writer of the correction.

A cycle carries one reason.
A findings cycle answers the corrections the Operator accepted.
An integration cycle combines the submitted result with other named revisions.
A diagnostic rerun runs recorded checks again when a test infrastructure failure is suspected.
A findings or integration cycle needs a reported review whose every finding already carries a disposition, because a cycle that starts on a half-read review leaves the unanswered findings with nothing to return to.
A diagnostic rerun needs a recorded check that did not pass, because a passing check has nothing to diagnose.

The cycle brief is written once, when the cycle is delegated.
It fixes the submission and its identity, every accepted correction with the reviewer evidence and the Operator reason, the conflicts to settle, the revisions to combine, the recorded checks, and a fixed copy of every submitted artifact.
The approved scope, the acceptance requirements, and the authority limits of the assignment are unchanged, because a correction is the same work rather than new work.

One cycle produces one combined revision.
Every accepted correction, every conflict, and every revision to combine is answered in that one submission, because a review reads one fixed result and a half-corrected one would be reviewed as if it were the whole answer.
A conflict is delegated with no recorded resolution of its own.
The Operator names what pulls against what, and the Operative settles it and submits that decision as part of the result.
Nothing between the two revisions is acceptable, because acceptance names the latest submission and the review that read it.

The combined revision registers its own review assignment, so a separate reviewer takes it.
That reviewer receives every earlier round: each finding, its disposition, the reason recorded with it, and the cycles those dispositions delegated.
It checks the revised result against them and reports a finding that came back as a regression.

Acceptance blocks on each of these, and every one of them is a recorded fact rather than an absence:
a finding with no disposition, an accepted correction whose cycle has not landed, a recorded check that did not pass, a check outcome a reviewer observed differently, an open direction request, and an input that was invalidated.
An approved requirement, a correctness or security defect, and a failed required check therefore reach acceptance only as a correction that landed or as a rejection that states its own evidence.

A rejected finding records the evidence that refutes it.
The Operator may still reject a blocker, which is the delegated authority ADR 0007 recorded, but a rejection contradicts a reviewer, and a reason with nothing behind it reads exactly like a finding waved away.

Three limits are counted from the crew state, so they outlive the session that reached them.
An assignment holds three correction cycles, counting findings and integration together, because both change the result.
It holds two diagnostic reruns, counted on their own, because a rerun changes nothing.
One review holds three attempts, which is one reviewer and two replacements, and each submitted revision registers its own review assignment and therefore its own budget.

A reached limit records a direction request against the assignment.
The request blocks acceptance, states the limit and what was already tried, and keeps every attempt, submission, review, and finding that led to it.
It is passed only by an approval that names this assignment, the scope of that limit, and the revision of the request it answers.
Reaching the same limit again moves that revision, so the approval that answered the earlier request covers nothing.

`operator work invalidate` records a defect found after acceptance.
The assignment moves to invalidated and returns to the frontier, because the fix is work on that assignment.
Its acceptance, submission, review, findings, and attempts stay exactly as they were recorded, because that history is what names the dependents that read the invalid result.
Only work that consumed the result is paused.
A dependent that never started has read nothing, and the dependency gate already holds it.
A paused dependent returns to the state it was paused from once the corrected result is accepted, and one that was accepted returns to the step that decided it, so that acceptance is taken again against the corrected input.

## Considered options

Reworking inside the review assignment was rejected.
The reviewer would then repair what it found, which is the reason review is a separate assignment at all.

Recording the Operator's resolution of a conflict was rejected.
The Operator would decide the work it is delegating, and a resolution that no result proves is an opinion rather than a correction.

Splitting the accepted corrections across two cycles was rejected.
Each partial result would need its own review, and a review of half an answer cannot say whether the whole answer is right.

Reviewing every intermediate revision was rejected.
Each review costs a Herdr slot and a full two-axis reading, and the only revision that can be accepted is the combined one.

Deleting the failed attempts when a limit is reached was rejected.
The evidence of what failed is the only thing that makes the user's direction an informed one.

A flag that raises a limit was rejected.
A limit any caller can raise is not a limit, so the user's own words are recorded as an approval bound to the revision of the request it answers.

Invalidating every dependent of a defective result was rejected.
Work that never started read nothing, and pausing it would say the crew lost more than it did.

Resuming a paused dependent through a second command was rejected.
The corrected result is the exact condition those dependents wait on, and a second decision that says the same thing is one more thing to forget.

## Consequences

A paused assignment is reported as blocked even while its former writer is still live.
The pause says what the crew may accept, not what a process is doing.
Stopping that process is [process closure](https://github.com/fveracoechea/operator/issues/25), which owns termination.

A rework cycle waits for capacity like any other work.
`operator work rework` returns the assignment to the frontier, and the frontier decides when it runs, so a busy crew delays a correction instead of preempting a review.

The Operator dispatches the cycle from the submitted commit.
Operator does not move a branch or a pull request, so the commit the cycle starts from is the one the caller names at dispatch, and the brief says so.

An integration cycle names the revisions it combines as text.
There is no tracker boundary in this release, so Operator records what the Operator read and never resolves those revisions itself.

The state version stays at 1.
The new tables are added to a file no release has shipped yet, and a state file that predates them is reported as unreadable rather than repaired in silence.
