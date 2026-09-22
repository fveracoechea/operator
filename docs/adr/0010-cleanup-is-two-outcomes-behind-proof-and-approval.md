# Cleanup is two recorded outcomes, each behind its own proof and approval

`operator cleanup close` ends one Operative process.
`operator cleanup remove` disposes of one Operative checkout.
They are separate records on one attempt, so a stop that cannot be proven never holds back a disposal that is already safe, and a refused disposal never reopens a process that is already closed.
Each one recovers on its own after a restart, and `operator cleanup show` reports both together with every retention hold.

Closure runs only after a durable handoff: a submitted result, or the two axis reports of a review.
It also reads the source revision and the acceptance requirements the result was produced against, the question the attempt may still wait on, and the checkout itself.
Work nobody registered, files a default status listing hides, an occupant this attempt never launched, and a child tool that outlived the host each retain the resources and name themselves as blockers.

Closure inventories the evidence before it stops anything.
The brief, the control reference, the release record, and every artifact the submission fixed are copied into the controlling checkout and read back by content.
The list is explicit, so a credential the host keeps in its own store is never archived beside the evidence.
Removal verifies those copies again, because deletion is the last moment at which the record could still be repaired from the worktree.

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

Widening remote preservation beyond the commits this attempt produced was rejected.
`git worktree remove` deletes the checkout directory and its administrative entry.
Branch references, their commits, and the stash stack live in the shared repository and survive it, so they are not what a removal puts at risk.
Reading the whole history of `HEAD` instead would refuse every removal in a project that has not published its main branch, which is the controlling checkout's business and not this cleanup's.

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

The state version stays at 1.
The two new tables are added to the schema this release creates, and a state file that predates them is reported as unreadable rather than repaired in silence.
