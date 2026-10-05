# Cleanup is two recorded outcomes, each behind its own proof and approval

`operator cleanup close` ends one Operative process.
`operator cleanup remove` disposes of one Operative checkout.
They are separate records on one attempt, so a stop that cannot be proven never holds back a disposal that is already safe, and a refused disposal never reopens a process that is already closed.
Each one recovers on its own after a restart, and `operator cleanup show` reports both together with every retention hold.

Closure runs only after a durable handoff: a submitted result, or the two axis reports of a review.
It also reads the source revision and the acceptance requirements the result was produced against, the question the attempt may still wait on, and the checkout itself.
Work nobody registered, an occupant this attempt never launched, and a child tool that outlived the host each retain the resources and name themselves as blockers.
Files a default status listing hides retain the checkout at removal, and they do not hold the closure.
A closure deletes no file, and the removal reads them again before anything is deleted.
So the ignored output of a gate command, such as an install, never holds the process.

Closure inventories the evidence before it stops anything.
The brief, the control reference, the release record, and every artifact the submission fixed are copied into the controlling checkout and read back by content.
The list is explicit, so a credential the host keeps in its own store is never archived beside the evidence.
Removal verifies those copies again, because deletion is the last moment at which the record could still be repaired from the worktree.

Removal also proves that no commit is lost with the checkout.
Git, read in the checkout, must show it on its recorded branch at the commit its handoff names: the submitted commit of a result, or the base of a review.
Any other head is work nobody handed over, and it retains the checkout.
When that commit is the accepted result of its assignment, the integration branch must still hold it.
The crew state names the commit on the branch that carries each accepted result, and removal reads the branch once: it must be at the recorded tip, with that commit in its history.
A branch at another tip, a missing branch, and a landing of the same source whose outcome is not recorded yet each retain the checkout, as ADR 0020 stops every other step on them: `integration_branch_moved` names both tips, `integration_branch_missing` names the branch, and `landing_pending` names the landing.
A head that is not the handed-over commit, or a detached head, is `head_moved`, and it names the recorded branch and commit and the ones it found.
A recorded tip that does not contain the recorded commit is `landing_not_held`, which only a corrupt record gives.
A checkout that holds a commit no recorded landing carries holds unlanded work.
That is a commit of an assignment that was withdrawn, and a replaced commit: the submitted commit of an attempt whose assignment was accepted through a different submission, as after a findings cycle.
Removal refuses it as `unlanded_work` with its cause, `withdrawn` or `replaced`, whatever approval exists, and `operator cleanup show` lists it under `unlanded`.
`crew next` offers no removal of it.
Only the person removes it.
A withdrawn attempt whose checkout holds no commit is removed like an accepted one, because nothing in it is lost.
No part of this proof reads a remote, so a removal never waits for publish.

Removal needs one more thing that acceptance does not grant: permission.
A per-cleanup approval names this checkout at the cleanup request revision.
A workflow approval names the repository at the workflow revision.
Both revisions cover the registered work and the Operator that owns the crew, and the cleanup revision also covers the checkout as it was inspected.
An approval therefore survives a restart, and it stops covering a changed workflow, a revoked grant, a human edit, and a takeover.

Every destructive step first proves that each name belongs to this attempt: the repository, the assignment, the attempt, the Herdr workspace and pane, the checkout Herdr actually holds, its branch, its occupants, and the attempts still writing there.
A missing workspace handle, a checkout Herdr does not hold, and a control reference that names another attempt are refusals, not details to work around.

Operator performs exactly two effects here, both through Herdr: the host's own stop keys, and an unforced worktree removal.
It deletes no branch, closes no workspace group, runs no Git removal, and deletes no file of its own.
Each effect records its intent before it acts, so a lost answer is settled from what Herdr shows rather than sent again.

## Considered options

One cleanup record covering both effects was rejected.
A failed stop would then hold a disposal that every other gate already permits, and one recovery would have to reason about two unrelated external systems.

Treating accepted completion as disposal authority was rejected.
Acceptance says the work is good, which is a different question from whether the resources that produced it may be destroyed.

Forcing the worktree removal was rejected, and so was deleting the checkout with Git or the filesystem.
Herdr owns these resources; an unsafe checkout is Herdr's refusal to report, not an obstacle for Operator to route around.

Reading only `git status` was rejected.
It hides ignored files, which is exactly where work nobody registered would sit unnoticed until it was gone.

Holding the closure on ignored files was rejected.
Every Operative that runs an install command of the gate then holds its process, and a closure deletes none of the files that the check protects.

A remote copy of every commit of the attempt was rejected.
Nothing pushes the integration branch before publish, a merge landing and a rewrite give an accepted result a new commit, and a replaced result never reaches a remote, so that proof would refuse almost every removal.
Pushing each attempt branch was rejected, because ADR 0020 keeps one push path, at publish.

A search for a commit with an equal patch on the integration branch was rejected.
Acceptance already proves the patch, and a second proof of the same policy in a second place drifts from the first.
It would also pass a branch that a person rebased, which ADR 0020 treats as a moved branch.

Removing a replaced commit with no proof was rejected (D3 of the integrated pull request specification).
Its record and its review reports stay, but the commit itself is on no integration branch, and Operator never tears down work that did not land.

Dropping the commit proof was rejected.
`git worktree remove` deletes the checkout directory and its administrative entry, and branch references, their commits, and the stash stack survive it.
But while a checkout holds its branch, Git refuses to delete that branch, so the checkout is the last guard of the attempt branch, and the proof shows that the accepted work has its own home before that guard goes.

Proving the whole history of `HEAD` was rejected.
It would refuse every removal in a project that has not published its main branch, which is the controlling checkout's business and not this cleanup's.

Sending the stop keys before reading Herdr was rejected.
A stop whose answer was lost would then be sent a second time, and the recorded operation could never be settled from evidence.

## Consequences

Operator's own paths inside a checkout are excluded from the reading that finds unregistered work, so an edit to them is invisible there.
The brief is checked against the identity the dispatch recorded, because it is the one launch input whose exact expected content the crew state holds.
An edit to an installed skill is still invisible at cleanup; the launch verifies those copies, and nothing re-verifies them afterwards.

The exact-revision gate on closure cannot be reached through the current commands.
Registration refuses a moved source revision and submission refuses a mismatched one, so no supported path moves those values under a finished result.
It stays because a later tracker or amendment step may move them, and it is the cheapest place to notice.

Removal requires the project to ignore what Operator writes into a checkout.
An unforced Herdr removal refuses a checkout with untracked files, and the launch inputs and installed skills are untracked in a project whose ignore rules do not name them.

Removal reads the integration branch and never moves it.
A checkout that outlives its integration branch, for example after a person deletes the branch when its pull request merges, is refused, and a person removes it.
A checkout of withdrawn work that holds its commit, and a checkout that holds a replaced commit, each stay until a person removes it.
So every findings cycle leaves one checkout for the person to remove.
That cost is accepted, because Operator never tears down work that did not land.

The state version stays at 1.
The two new tables are added to the schema this release creates, and a state file that predates them is reported as unreadable rather than repaired in silence.

## Amendment, 2026-10-05

Files that a default status listing hides held the closure and the removal before this date.
Now they retain only the checkout at removal.
The ignored output of a gate command, such as an install, held the process of each Operative that ran it, and a closure deletes no file that the check protects.
