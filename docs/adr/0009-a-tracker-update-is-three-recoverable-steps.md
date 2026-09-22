# A tracker update is three recoverable steps, and an unproven write is never repeated

Completing work on a tracker is three separate outcomes: the resolution is recorded, the ticket is completed, and the map is amended.
Each one holds its own intent, its own write attempts, its own evidence, and its own recovery action.
The whole update completes only when every applicable step is verified, and a verified step is never written again to repair another.

The integration boundary is tracker-neutral and GitHub is its only implementation in this release.
Each assignment records the tracker and the ticket it was registered from, so a later configuration change cannot redirect work that already exists.
An assignment with no recorded ticket refuses its tracker updates rather than writing to a guessed one.

A logical operation is named before its first write, and it keeps that name through every recovery attempt.
A comment carries the name in an HTML marker, which is a lookup convention and nothing more: it is not authentication, and GitHub enforces no uniqueness on it.
Recovery reads the exact comment when the server named one, and otherwise reads every accessible comment page and records what that scan covered.
One exact match by the expected actor is evidence that the intended comment exists at observation time.
Two matches, different content, and another actor are each a conflict that a person settles; Operator never edits or deletes a comment to repair one.

A write that never returned a definite answer stays uncertain, because it may still have applied.
Another write under that operation requires a person's approval bound to the operation and to the number of attempts already recorded, so one approval covers exactly one more write and the earlier unresolved attempt stays in the history.
Elapsed time, an empty scan, and an agent inference authorize nothing.

Completion reads the ticket before it closes it, and so does any step that already sent a write.
An observed closed state with the intended reason satisfies the step without claiming that Operator's request caused it, and the observed state, reason, actor, times, and closure events are recorded as what they are.
A different close reason is a conflict, and a reopen after the close stops automatic closure.
A state the reading could not establish stops the write as well, because a reopen nobody could see would otherwise be overridden with no approval.

The canonical map is its baseline body plus explicit amendment comments.
Operator never replaces a shared issue body, because GitHub offers no conditional write on that endpoint that another writer would lose.
There is no code path that writes one and no request that can ask for one, so the guarantee is structural rather than a flag a later change could flip.
An amendment states the sections it changes, what it supersedes, and the baseline identity it was written against, so independent additions combine and two amendments of one section stop the session instead of letting comment order pick a winner.

Every step reports one provider-neutral reason from the approved tracker vocabulary.
An operation that holds several problems keeps all of them and ranks the overall result in one order: uncertain external effect, conflict, missing condition, definite failure, pending work.

## Considered options

Selecting the tracker from project configuration was rejected for this release.
The binding that matters is the one recorded at registration, and a second selector with one possible value would be a second source of truth for the same fact.
A project-level default belongs with the second provider, when there is something to choose between.

Treating an empty comment scan as proof that a write never applied was rejected.
It is the fastest way to write a duplicate comment, and a failed read proves even less.

Replacing the map body under a fresh read, a local lock, or a post-write comparison was rejected.
None of those is a guard another writer loses, so each one silently discards a concurrent edit.

Recording the absent body-replacement guard as a provider capability was rejected.
A flag that only ever reads false is a switch with no second position, and enabling it would have turned on a half-built path that still wrote a comment.
Supporting a shared-body write means adding the write itself, which is a deliberate change and not a configuration value.

Repeating a compound "comment and close" command on recovery was rejected.
It repeats whichever half already succeeded.

Correcting content under the same logical operation was rejected.
Changed content is not a retry of an exact-content operation, so a request that changes it is refused and names what it would take instead.

## Consequences

An approved correction is not implemented here.
A step whose content must change is refused with the reason, and the new operation that supersedes an earlier result is follow-up work.

Acceptance still compares the pull request head a caller states against the head the submission recorded.
This boundary reads issues, comments, and closure events; reading a live pull request head is a separate gate and is not part of this decision.

The state version stays at 1.
The new tables are added to a file no release has shipped yet, and a state file that predates them is reported as unreadable rather than repaired in silence.
