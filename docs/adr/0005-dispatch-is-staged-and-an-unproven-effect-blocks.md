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

The brief is the contract of one attempt.
It carries every rule that binds the Operative, every command the Operative runs, and the refusal each command can give, so a rule that a command enforces is stated once, beside that command.
The owned skill that the Operative loads carries the method of the work and restates no rule of the brief.
The Operator writes nothing into a brief: the work of one assignment is its approved scope, and anything the Operative must learn after launch arrives as a recorded answer.

The rules that are the same for every launch belong to the release, so the launch snapshot fixes them together with the code that enforces them.
The rules of one project belong to its committed project instructions, which the host loads by its own mechanism and which the reviewer reads as the standards of the project.
The base commit fixes them for a launch, so an edit that is not committed does not reach the crew, and each rule has one copy that the producer and the reviewer both read.
A personal instruction file is outside the launch: Operator neither copies it nor records it, so a rule the crew must follow lives in the project.

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


One shared rule block, registered as a fixed input on every item, was rejected.
It needs no new code, and the hand-run flow that this crew automates used one.
The reviewer never receives a fixed input of the producer, every item holds its own copy, and an item that an attempt already read keeps the old copy after the block changes.

A field in the project configuration, copied into every brief, was rejected.
It gives each project one place for its rules.
That configuration is local to one checkout and nobody reviews it, so another checkout launches with other rules, and the reviewer never reads them.

Every rule of the block in the project instructions, the launch rules included, was rejected.
It puts the whole block in one file that the project controls.
The project would then restate a protocol that the release owns and enforces, and one file would disagree with every release but one.

A recorded identity for each instruction file in the launch snapshot was rejected.
It would make a changed instruction file visible to recovery.
The base commit already fixes every committed file, and the record would need a list of the file names that each host loads, which drifts when a host adds one.

Copying or recording a personal instruction file was rejected.
It would let a rule that lives on one machine reach the crew.
Another machine cannot reproduce it, it can hold private content, and a launch copies an explicit list and nothing else.

## Consequences

Takeover blocks every existing attempt.
An attempt is current only while the Operator that claimed it still owns the crew, so a new owner cannot dispatch, reconcile, replace, or acknowledge one until an adoption step exists.
That step belongs to the coordination workflow, not here.

A replacement retains the checkout, so its Herdr workspace must still be open.
A closed workspace blocks the launch of the replacement rather than creating a second checkout.

The state version stays at 1.
It changes when a released Operator can no longer read the tables, and no release has shipped yet.
A state file that predates a table this release reads is reported as unreadable and is never repaired in silence.

A rule that the crew must follow and that no check enforces is committed to the project instructions before the work that needs it is dispatched.

The reviewer works in the submitted commit, so a result that edits the project instructions is reviewed under the rules it wrote.
The write paths that the user approved are the authority for that edit, and the edit is visible in the diff.
