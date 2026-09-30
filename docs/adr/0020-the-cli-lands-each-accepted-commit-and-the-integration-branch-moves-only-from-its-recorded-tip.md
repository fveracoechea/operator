# The CLI lands each accepted commit, and the integration branch moves only from its recorded tip

`operator work accept` lands a code result on the integration branch of its source as the last step of acceptance.
Every other gate of ADR 0007 passes first, then the branch moves, and then acceptance is recorded.
So the branch never holds a commit that failed another gate, and acceptance never refuses after a commit is on the branch.
A commit that the branch already holds with an equal patch lands nothing, and its acceptance is only recorded.

The CLI lands a commit itself, with no worktree and no edit.
When the parent of the reviewed commit is the tip, the branch moves to that commit.
Otherwise the CLI merges the change of the commit onto the tip, with the parent of the commit as the merge base, and makes a new commit with the author, the committer, both dates, and the message of the reviewed commit, and no signature.
The landed commit is therefore known before the branch moves, and a repeat gives the same commit.
The move is one staged effect under ADR 0005: its intent names the tip it moves from and the commit it moves to, and the branch moves only if it still holds that tip.
Recovery reads the branch once: the old tip means the move did not happen, the planned commit means it did, and anything else is a moved branch.

A landing needs the same patch, as ADR 0015 records.
The patch is the change with its usual context lines and its whitespace, from one canonical diff that detects no renames.
This strict patch never refuses a normal landing, because two results in flight never touch the same file.
That holds only because of two other rules: the frontier holds the write paths of unaccepted work (ADR 0004), and a result that touches a file outside its write paths, on either side of a rename, is refused at submit (ADR 0018).
If either rule becomes weaker, this identity must be chosen again.

A conflict, or a changed patch, lands nothing and records nothing.
The Operator then delegates an integration cycle under ADR 0008.
The cycle plans the landing again, refuses if the commit would now land cleanly, and names the submitted commit and the current tip as the revisions it combines.
A fresh Operative makes one new commit on that tip, and it is a new submission with its own result review, as ADR 0017 records.

The integration branch is a local branch of the shared repository, in a namespace of its own, and its name is recorded on the source when it is created.
Its base is the commit that the first code dispatch of the source names, and that base is fixed for the life of the source.
Every later production dispatch of the source starts from the recorded tip, so its base holds every result it depends on.
An invalidated assignment whose commit is on the branch starts from that commit instead, on the parent of that commit, because its correction takes the place of that commit.
Nothing pushes the branch before publish, and publish pushes it with the user's approval and never with force.

A branch that moved outside this protocol stops every landing, rewrite, and production dispatch of its source, and a branch that a worktree has checked out stops every landing and rewrite.
The refusal names the tip that was recorded and the tip that was found, or the worktree.
Operator never resets or adopts a moved branch; a person puts it back.

A correction of a landed commit is rewritten in place.
When the correction is accepted, the CLI rebuilds the branch in the same order: the corrected commit takes the place of the old one, and each later commit lands again if its patch is still equal and no result it depends on was taken out.
A later commit that fails either test is taken out of the branch and paused as a consumer of the corrected result under ADR 0008.
Its acceptance is taken again later as an ordinary landing on the tip.
If its patch is equal, it lands with no new review; if not, it becomes an integration cycle.
The branch moves once, from the old tip to the rebuilt one.
This check of every later commit replaces a separate check that corrected commits share no file, and it finds more: a correction and a later commit that no correction targets.

A commit inside a published pull request of the stack is never rewritten in place.
A rewrite whose position is inside a published range refuses and names that pull request, and the publish decision owns what follows.
A commit that landed after the last publish is rewritten locally like any other.

## Considered options

An integration assignment kind for an Operative was rejected.
Each landing would take a crew slot and a Herdr agent for a step with no judgment, the branch would get a second kind of writer, and the CLI would still have to prove the patch afterwards.

Integration by the Operator agent by hand was rejected.
The Operator holds no worktree of its own (ADR 0008), and a hand step leaves no record to recover from.

A landing at submission, before review, was rejected.
Later dispatches would start from unaccepted commits, and every refused acceptance would rewrite the branch under them.

A separate landing command before acceptance was rejected.
It makes "landed and not accepted" a real state between two commands, and ADR 0015 already rejected a separate integrated state.

A patch identity with no context lines was rejected.
The reviewer would no longer read the exact patch that lands, and with the write-path hold the strict identity costs nothing.

A hidden reference in place of a branch was rejected, and so was a branch only on the remote.
Every Git tool reads a plain local branch, and a remote-only branch makes every landing a network write.

A push after each landing was rejected.
A push writes where other people read, and one push path at publish is less to keep correct.

A base recorded at registration was rejected, because registration reads only the tracker.
A base that follows the main branch was rejected, because the rebase that follows it changes patches that were already accepted.

A committer of the current user at the current time was rejected.
The landed commit would be known only after the move, so recovery could not name what it expects.

Adopting a moved branch as the new tip was rejected, because it puts unreviewed commits under later work.
Resetting it was rejected, because it deletes work of a person.

An integration cycle that the refused acceptance opens by itself was rejected.
A refused command changes nothing, and the instruction and the conflicts of a cycle are the Operator's judgment.

A correction as a new commit on top was rejected.
The corrected assignment would own two commits, and its first commit would still fail the gate on its own.
A fixup on top with a squash before publish was rejected for the same reason, and because every dispatch until publish would start from a commit that no assignment owns.

A rewrite that waits until every later commit it disturbs has a new reviewed revision was rejected.
The disturbed commits would stay accepted while a newer revision waits, which is a second integrated state; the rebuilt history would sit on no branch; the defect would stay under new work until the slowest of those reviews ends; and one acceptance would land several assignments.

A rewrite of a published range with a force push was rejected.
Other people already read what was published.

## Consequences

A landing runs no check, because it has no worktree.
Whether a gate runs on the landed tree, and when, is the decision about the gate at every commit.

A fast-forward landing keeps the commit identity of the Operative, and a merge landing gives a new identity with an equal patch.
A rewrite gives every later commit a new identity, so a link to a commit is written only after the last change of the branch.

A landed commit carries no signature of the user.
Signing, if a project needs it, belongs to publish.

Two sources that share code are one source, or they run one after the other, as ADR 0016 records.

The crew state records the integration branch of each source, its base, its recorded tip, and each landing with its intent and outcome, so the state version moves with the migration that ADR 0015 already requires.
A landing whose outcome was not recorded is a recovery action of the next actions, ahead of new work, as ADR 0011 orders recovery.

Operator now needs a Git version that can merge without a worktree, and readiness refuses an older one.
