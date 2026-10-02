# An integration branch is reviewed as a whole before it is published

A result review reads one submission alone, from the base of its own dispatch.
It sees the results that its assignment depends on, but not a commit that landed in parallel or after its dispatch.
A defect that shows only as the relation between two commits, such as a pattern that one commit removes and a later commit adds again, is therefore invisible to every result review.

Two reviews run.
The result review of each submission stays the gate of accepted completion, as ADR 0007 records, so a dependent never starts from an unreviewed result and no barrier holds parallel work.
A branch review then reads the integration branch of the source as a whole, and it gates the publish.

The branch review runs once for the source, when every executable code assignment of the source that is not withdrawn is accepted.
An invalidated assignment, or an open direction request, holds it, because the branch is then not final.
The acceptance, the withdrawal, or the take-out that makes this condition true registers the branch review, in the same way that a submission registers its result review.
A source with one code commit, whose spec is the spec of that one item, has no branch review, because that review would read exactly what the result review already read.

A branch review is ordinary review work under ADR 0007.
Its subject is a branch snapshot: the source, the base of the integration branch, one head commit, and the ordered commits with the accepted submission of each one.
Its report names the identity of that snapshot, and the reviewer starts from that head and no other.
It reads the whole range, the fixed requirements of the source and of every item, and the findings and dispositions of every earlier review of the source.
It looks for what no result review could see: a relation between commits, and the coverage of the source as a whole.
Each finding names the commits it targets.

Publish refuses unless one branch review reported on the exact head to publish, every finding carries a disposition, and no correction is pending.
The review binds to one head, because a correction or a rebase changes what ships, and a review of an earlier head proves nothing about it.

A branch finding is answered with the three dispositions of ADR 0007.
A correction names exactly one target assignment and invalidates it through the path of ADR 0008, because a defect in accepted work already has one path and a second one would drift.
The target holds one of the commits that the finding targets, and the invalidation is recorded in the same change as the disposition, so a corrected finding never waits for a second step that nothing owes.
The corrected result is a new submission with its own result review.
When the corrected assignment and every dependent it paused are accepted again, that acceptance registers the next branch review, on the new head, with every earlier branch round as context.

One source holds three branch reviews that reported, whatever changed the head between them.
A fourth records a direction request under ADR 0008, and publish waits on the user.

A commit whose patch changed during integration is not the reviewed result, as ADR 0015 records.
It is a new submission of the same assignment, and its result review also receives the reviewed patch and the change from that patch to the new one.
The branch review never stands in for that result review.

## Considered options

A branch review in place of the result review was rejected.
Acceptance would then wait for the whole branch, which is the barrier ADR 0015 rejected, or a dependent would start from unreviewed work, which ADR 0004 forbids.

A result review that reads its commit on the current tip of the branch was rejected.
The tip moves, so the evidence is not fixed, and a sibling that lands after the review is still unseen.

A branch review after each commit lands was rejected.
It finds a relation between commits earlier, but it runs a second review for every result.

A branch review for each part of a stack was rejected.
The whole stack is published at once (ADR 0022), so no part is published before the review of the whole head.

A submission with no producer, as the subject of a branch review, was rejected.
Acceptance, rework, and invalidation all read a submission as the result of one assignment.

A correction commit on top of the branch was rejected.
The history would then hold a commit that closes no item of its own, and a reader of one commit would no longer see the whole change of its item.

A correction of accepted work without invalidation was rejected.
It would be a second path for a defect found after acceptance.

A review of only the range that a correction changed was rejected.
A relation between commits can join a commit below the correction with one above it.

An interdiff review in place of a full result review for a changed patch was rejected.
A conflict resolution can change what the unchanged lines mean, and acceptance would then read two kinds of reviewed evidence.

## Consequences

A branch finding against an early commit pauses every accepted dependent that consumed it, and each one is accepted again after the correction lands.
The correction also moves every later commit to a new base, and a conflict in that move is a changed patch that needs its own result review.
That cost is accepted.
When a finding joins two commits, the later one usually has fewer dependents, so it is the cheaper target, but the Operator chooses with a reason.

The tracker steps of a code result run only after its pull request merged (ADR 0022), and every branch review comes before publish, so a branch finding never reopens a closed ticket.

The branch review runs the project gate at the head, and publish refuses when that observation differs from the gate run at the head, as ADR 0021 records.
Both bind to the tree of the head, so a signature at publish does not break the comparison.

A fresh Operative writes the correction, in an invalidation cycle under ADR 0008.
ADR 0020 records how a corrected commit replaces the old one on the branch.
