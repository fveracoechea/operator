# Dispatch is staged, and an unproven external effect blocks instead of repeating

`operator attempt dispatch` fixes the whole launch before it acts.
The recorded plan holds the attempt, the explicit base commit, the branch, the checkout path, the launch snapshot, the brief identity, and the prompt identity.
Each of the four external effects then records its intent and its own identity before the call and its outcome after it.
An interrupted dispatch therefore recomputes the same plan and resumes at the first unfinished effect.

The four effects are the Herdr worktree, the copy of the fixed inputs, the agent start, and the prompt submission.
Copying is verified and repeatable, so an unfinished copy is simply performed again.
A Herdr effect that never answered is uncertain: it may have landed.
`operator attempt dispatch` refuses to act again on such an attempt, and `operator attempt reconcile` settles it from what Herdr and the checkout actually show.

Herdr acknowledges a prompt submission, never a turn.
The Operative's own `operator attempt acknowledge` is therefore the only proof that the brief arrived.
An acknowledgement also settles an unproven delivery, because the Operative could not have acknowledged a brief it never received.
A delivery that stays unproven while the writer is live goes to the user; it is never resent.

A launch snapshot fixes the effective crew host and model, the Operator release, its lock data, and the skill contents.
Recovery restores that record.
A drifted input blocks the attempt and names each changed field, and a session override cannot replace it.
New work uses current settings; work already in progress does not.

Each Operative worktree receives the project configuration, its schema, a release record, the frozen lock data, a control reference, the brief, and the skills of this release.
No other file is copied out of the controlling checkout, so credentials stay in the host credential store.
Every copy is read back and compared before any agent starts.

`operator attempt replace` starts a new attempt on the same assignment.
It runs only when every effect is settled, the former writer is proven stopped, and the caller states the identity of the partial-work inspection it read.
It keeps the inspected checkout and branch, so one assignment never holds two writers and no partial work is discarded.

Operator calls Herdr only through one boundary.
Direct Herdr use stays read-only inspection and bounded waits.

## Considered options

Treating a timed-out or lost Herdr answer as non-delivery was rejected.
It is the fastest way to produce a second writer on one assignment.

`agent prompt --wait` as the proof of delivery was rejected.
Herdr does not track turns, so a working agent's earlier turn can satisfy that wait.

Storing the reached stage as its own column was rejected.
The recorded effects already answer that question, and two renderings of one fact drift.

Repeating the whole dispatch under one request identity was rejected.
Each stage carries its own derived identity, so a replay returns the recorded outcome of each finished stage instead of refusing the whole request.

Copying the controlling checkout's `.operator` directory into the worktree was rejected.
That directory holds the crew state and whatever else the user keeps there, and a launch must copy an explicit list.

## Consequences

Takeover blocks every existing attempt.
An attempt is current only while the Operator that claimed it still owns the crew, so a new owner cannot dispatch, reconcile, replace, or acknowledge one until an adoption step exists.
That step belongs to the coordination workflow, not here.

A replacement retains the checkout, so its Herdr workspace must still be open.
A closed workspace blocks the launch of the replacement rather than creating a second checkout.

The state version stays at 1.
It changes when a released Operator can no longer read the tables, and no release has shipped yet.
A state file that predates a table this release reads is reported as unreadable and is never repaired in silence.
