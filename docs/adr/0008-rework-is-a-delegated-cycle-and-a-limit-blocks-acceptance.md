# Rework is a delegated cycle, and a reached limit or a found defect blocks acceptance

`operator work rework` delegates one correction round on one submitted result, and `operator work invalidate` delegates one on an accepted result that a defect was found in.
The cycle is registered against the producer assignment, never against the review, so the assignment returns to the frontier and the correction reaches a fresh Operative through the ordinary claim and dispatch path.
A fresh Operative is a new attempt, in a new agent session and a new checkout.
The reviewer that found the problem never repairs it, the Operator holds no worktree it writes in, and the attempt of the producer ended at its submission, so none of them is the writer of the correction.
The gate checkout of ADR 0021 never commits and never moves a branch, so it does not change this.
The producer fixes its own work with its own context in one place only: a refusal at submit, which leaves its attempt running, as ADR 0018 records.

A cycle carries one reason.
A findings cycle answers the corrections the Operator accepted.
An integration cycle combines the submitted result with other named revisions, when it no longer lands as reviewed: a conflict, a changed patch, or a candidate that failed the project gate (ADR 0021).
A diagnostic rerun runs recorded checks again when a test infrastructure failure is suspected.
An invalidation cycle corrects the defect that an invalidation recorded.
A findings cycle needs a reported review whose every finding already carries a disposition, because a cycle that starts on a half-read review leaves the unanswered findings with nothing to return to.
An integration cycle names a review only when it answers one, because a revision can need combining before any reviewer has read it.
A review that already reported is answered either way, so its findings are never combined away unanswered.
A diagnostic rerun needs a recorded check that did not pass, because a passing check has nothing to diagnose.
An invalidation cycle opens in the same change as the invalidation, because the recorded defect is already the work it carries.

The cycle is fixed once, when it is delegated.
It fixes the submission and its identity, every accepted correction with the reviewer evidence and the Operator reason, the conflicts to settle, the revisions to combine, the recorded checks, and a fixed copy of every submitted artifact.
An invalidation cycle fixes the defect in the words of its finder, the finding with its target commits and its disposition when a branch review found the defect, and the accepted submission and the landed commit that it corrects.

The Operator writes no instruction of its own into a cycle.
Each reason renders one fixed sentence that the release owns, and the recorded findings, defect, conflicts, commits, or checks are the content.
A disposition reason and a conflict stay, because each one is a recorded decision bound to a finding or to work that the cycle carries.

A fresh writer does not hold the context of the producer, so the brief of every cycle carries what the crew state recorded about the earlier rounds of the assignment.
That is the decisions, the concerns, and the behavior changes of the submission it corrects, every answered question of every earlier attempt, and every earlier finding with its disposition, its reason, and the cycle it delegated.
The writer therefore reads the same rounds that the reviewer of its revision checks for a regression.
The brief also carries the planning records that the assignment depends on, derived again at the dispatch of the cycle, so a correction follows the decision that is accepted now.
All of it is derived from the record at dispatch and fixed by the brief identity, so the Operator copies nothing and a replacement receives the same words.
The approved scope, the acceptance requirements, and the authority limits of the assignment are unchanged, because a correction is the same work rather than new work.

One cycle produces one combined revision.
Every accepted correction, every conflict, and every revision to combine is answered in that one submission, because a review reads one fixed result and a half-corrected one would be reviewed as if it were the whole answer.
A conflict is delegated with no recorded resolution of its own.
The Operator names what pulls against what, and the Operative settles it and submits that decision as part of the result.
A conflict names only work the cycle carries, read across every round of the assignment, so a finding the cycle does not correct cannot be named as work it settles.
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
An assignment holds three correction cycles, counting findings, integration, and invalidation cycles together, because each of them changes the result.
It holds two diagnostic reruns, counted on their own, because a rerun changes nothing.
One review holds three attempts, which is one reviewer and two replacements, and each submitted revision registers its own review assignment and therefore its own budget.
A work source also holds three branch reviews that reported, and ADR 0017 records why a fourth waits on a direction request in the same way.

A reached limit records a direction request against the assignment.
An invalidation that finds the budget spent still records the defect and pauses what consumed it, because a found defect is never refused, and it records the direction request in the same change, which withholds the dispatch of the correction until the user answers.
The request blocks acceptance, states the limit and what was already tried, and keeps every attempt, submission, review, and finding that led to it.
It is passed only by an approval that names this assignment, the scope of that limit, and the revision of the request it answers.
The cycle that approval permits records it, and the brief of that cycle states it, so work past a limit is visible to the Operative that runs it.
A request keeps taking the evidence of every further attempt that reached the same limit, whatever state it is in, because those failures all happened.
An open request keeps its revision, because an approval is bound to that revision.
A limit reached again after a direction was spent opens the request at the next revision, so the approval that answered the earlier one covers nothing.

`operator work invalidate` records a defect found after acceptance.
Review work is refused, because a review holds no result of its own and a review that read the work wrongly is answered by reviewing that work again.
The assignment moves to invalidated and returns to the frontier, because the fix is work on that assignment, and the invalidation cycle that the same change opens carries that fix.
Planning work opens no cycle, because it is never dispatched, and the Operator resolves it again, as ADR 0019 records.
Its acceptance, submission, review, findings, and attempts stay exactly as they were recorded, because that history is what names the dependents that read the invalid result.
Only work that consumed the result is paused.
A dependent that never started has read nothing, and the dependency gate already holds it.
The pause is this workflow's own mark, so what a dependent was doing before any pause is what says whether it read anything, and a dependent of two invalid results is recorded against both.
A paused dependent returns to the state it was paused from once every defect it read is corrected, and one that was accepted returns to the step that decided it, so that acceptance is taken again against the corrected input.

## Considered options

Reworking inside the review assignment was rejected.
The reviewer would then repair what it found, which is the reason review is a separate assignment at all.

Recording the Operator's resolution of a conflict was rejected.
The Operator would decide the work it is delegating, and a resolution that no result proves is an opinion rather than a correction.

Splitting the accepted corrections across two cycles was rejected.
Each partial result would need its own review, and a review of half an answer cannot say whether the whole answer is right.

Reviewing every intermediate revision was rejected.
Each review costs a Herdr slot and a full two-axis reading, and the only revision that can be accepted is the combined one.

Deleting the failed attempts when a limit is reached was rejected, and so was replacing the evidence of the earlier ones.
The record of what failed is the only thing that makes the user's direction an informed one, and a second failure does not undo the first.

A flag that raises a limit was rejected.
A limit any caller can raise is not a limit, so the user's own words are recorded as an approval bound to the revision of the request it answers.

Invalidating every dependent of a defective result was rejected.
Work that never started read nothing, and pausing it would say the crew lost more than it did.

Resuming a paused dependent through a second command was rejected.
The corrected result is the exact condition those dependents wait on, and a second decision that says the same thing is one more thing to forget.

Repair by the producer, with the context it built, was rejected.
In the flow run by hand, each fix went back to the agent that wrote the commit, and that agent amended its commit with its full context.
Here a producer kept for its review would hold its crew slot through that review, which stops a one-agent crew, or it would run as an agent that no limit counts.
An integration cycle starts on a tip the producer never saw, and a correction of accepted work comes after the producer was closed, so a producer path would sit beside the fresh path that those cycles, and a producer that stopped, still need.
The context of a producer also holds reasoning that nothing recorded, and no recovery can restore it, while a fresh writer reads only what its brief fixes.
The slot rule, the one writer path, and the recorded inputs carry this decision.
The independence of the writer is a minor reason, because a separate reviewer reads the combined revision either way, and a fresh writer gains only that it does not defend its own earlier reading.
The accepted cost is one launch and one full reading of the brief and the code for each cycle, and a fresh writer can misread what the producer meant.
The recorded rounds in the brief reduce that cost, and they do not remove it.

A free instruction from the Operator in the brief of a cycle was rejected.
It is bound to no finding, so nothing can compare it with the work the cycle carries, and it can ask for work that no finding names.

A correction of accepted work that receives only the ordinary production brief was rejected.
Its writer would have to find the defect again, and a defect from any finder would correct the same work with no limit.

A findings cycle that the Operator opens by hand on an invalidated assignment was rejected.
It is a second command for a defect that is already recorded, and a finder that is not a review has no review to name.

## Consequences

A paused assignment is reported as blocked even while its former writer is still live.
The pause says what the crew may accept, not what a process is doing.
Stopping that process is [process closure](https://github.com/fveracoechea/operator/issues/25), which owns termination.

A rework cycle waits for capacity like any other work.
`operator work rework` returns the assignment to the frontier, and the frontier decides when it runs, so a busy crew delays a correction instead of preempting a review.

Each cycle starts from the commit that its reason names, and the brief says which commit that is.
A findings cycle and a diagnostic rerun start from the submitted commit, on the base of its dispatch.
An integration cycle starts from the commit that its result lands on: the tip of the integration branch, or, in a rewrite, the parent of the commit it replaces.
An invalidation cycle of a code result starts from the landed commit that it corrects, on the parent of that commit, as ADR 0020 records.
Operator moves one branch, the integration branch of a source, and only as ADR 0020 records.
It never moves an Operative branch, and it changes a pull request only as ADR 0022 records.

An integration cycle names the revisions it combines as commits that Operator read: the submitted commit, and the tip on which it no longer lands as reviewed.

The state version stays at 1.
The new tables are added to a file no release has shipped yet, and a state file that predates them is reported as unreadable rather than repaired in silence.
