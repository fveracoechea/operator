# A planning decision is recorded at acceptance and reaches its direct dependents

Planning work reaches accepted completion with no attempt, as ADR 0004 records.
The Operator is read-only and keeps its own context low, so the crew does the reading and prepares the decision, and the Operator brings each question to the user and records the acceptance.
That acceptance records a planning record, and `operator work accept` refuses planning work without one, also when the planning work was invalidated and is decided again.
It also refuses planning work whose own dependencies are not accepted, because a decision on inputs that can still change is not a decision.
The planning record is what the planning work gives to the work that waits on it.

A planning record is an ordered list of decision entries, and a list of artifacts.
Each entry holds the question as it was asked, its answer authority, the exact words, and the interpretation of them, in the shape of an answer of ADR 0006.
The question stays beside the words, because a short answer such as "sounds good" has a meaning only next to the question it answers.
The interpretation states what the decision covers, and it never names who receives it.
An artifact is a longer text, such as a resolution document or a proposed ADR text, that Operator stores as a copy and identifies by its content.

The authority of a planning decision follows the type of the planning work.
A grilling or a prototype is the human side of a decision, so each of its entries is a human answer or a requirement, and never an Operator decision, whatever subjects the Operator declares.
No Operative raises a planning question, so the Operator would be the only party to declare an escalation subject, and a subject declared by the party that wants the answer is not a check.
A requirement still cannot close unresolved ambiguity or conflicting requirements, so where no approved source states the answer, or two sources disagree, the Operator asks the user.
A research ticket may record an Operator decision, because its result is findings and not a choice for the user.
Planning work of a specification or a ticket follows the rule of a grilling, because its recorded kind does not say which side of a decision it is.

A general delegation from the user, such as "decide from my opinions", is not a human answer to each question.
It makes the source it names an approved source, and a quote from that source is a requirement.
A decision that no approved source states goes back to the user.

A requirement names its source by a stored copy, and the revision of the source is the content identity of that copy.
The exact words of a requirement must appear, byte for byte, in that copy, after a carriage return before a line feed is removed, and Operator refuses a requirement whose words do not.
The check runs before the copy is stored, so a refused quote leaves no copy, and the refusal names the source file it read.
A text that the crew state already holds, such as the approved scope of a registered item or a work source revision, is a source with no copy.
A work source revision is quoted from the copy that the source store holds for it, and the requirement names the revision, so a quote of a revision that the crew state no longer records refuses as `source_revision_changed`.
A source outside the checkout, such as a file that only the user keeps, is valid, because the copy fixes what the quote was checked against, and a later edit of the file does not make the record false.
The copy of a source stays with the crew state and never enters a worktree: the quoted words reach the crew through the record, and the rest of the file does not.

At dispatch, the brief of each direct dependent carries the planning record of every accepted planning assignment that it depends on.
The artifacts of those records are copied into the worktree, in the same way that a reviewer receives the artifacts of a submission.
The record is derived from the dependency, so the Operator input names no receiver, and the Operator cannot forget a dependent or copy the words wrong.
The brief identity covers the record, so a recovery restores the same words.
Only a direct dependent receives a record.
A task that needs a decision gets a blocking link to the planning work on the tracker, and a task further down the chain receives the effect of the decision through the commit that it builds on.
Planning work has no brief, so the action that resolves it in the next-actions read names the record of each direct planning dependency.
The Operator reads that action and keeps its own context low, so the action carries only the record identity, its content identity, its entry count, and the command that prints the full record: `operator work record`.
The crew that prepares the decision reads the full record with that command, and the Operator does not.
The fixed copy of the requirements that a result review reads, as ADR 0007 records, also holds the planning records that the brief of the producer carried, so the Spec axis checks the result against the decisions it followed.

A planning record is fixed once it is accepted.
A decision that changes after acceptance is an invalidation of the planning work: the dependents that consumed it pause, and a new acceptance with a new record releases them.
A dependent that was already running keeps the brief it was launched with, as it does for every other input.

The tracker resolution of planning work is a rendering of its record: every entry in order, then the content of each text artifact in order.
It takes no free text, so the tracker and the brief of a dependent carry the same words.
The prose of a decision, such as the rejected options and the consequences for other work, is a text artifact of the record, and the crew writes it, because the Operator writes no content of its own.
A rendered body that the tracker would refuse is refused before the write, with its size.
The GitHub documentation states no limit for a comment body, so the limit is the one the GitHub API states when it refuses a body: 65536 characters.

A planning item makes no commit, as ADR 0016 records.
A doc change that a decision needs is production work that depends on the planning work.
A person or a planning skill creates it, and it receives the approved text through its brief, so its Operative applies the approved words and does not write them again.

## Considered options

An Operator that adds the decision to each dependent by hand, as a fixed input at a new registration, was rejected.
It is a hand copy of a rule that the dependency already states, and it makes a second list of receivers that drifts from the first.

A person who writes the decision into the issue of each dependent was rejected.
Operator never writes an issue body, as ADR 0009 records, so the user would edit every dependent and approve a new registration for each one.
The own open choice of one item still uses this path, because that item is already a changed item under ADR 0016.

The tracker resolution comment as the only record, read by the Operative from the tracker, was rejected.
It is free text with no split between the words and their reading, and the tracker can change after dispatch.

A planning item that lands its own doc commit was rejected.
It would give planning work a commit and an integration step, and planning work is never dispatched.

A planning Operative that runs the grilling and submits the decision as a result was rejected.
The user speaks only to the Operator, so that Operative would relay each round through a question, which adds a crew slot and a review and no authority.

An Operator decision under a general delegation, with the escalation subjects declared by the Operator, was rejected.
Almost every design question names visible behavior or scope, so an honest declaration refuses it, and a dishonest one is not a check.
It also records less than the Operator knows, because it quotes nobody where a quote of the user's own source exists.

One answer for each planning item was rejected.
A grilling session mixes decisions that quote a source with decisions that the user gave directly, and one authority cannot describe both.

A record for every transitive dependent was rejected.
It grows each brief along a long chain and gives an Operative decisions that nobody linked to its work.

A record that is optional for some planning work was rejected.
A planning item that blocks work exists to give that work something, and an acceptance that records nothing unblocks a dependent that then receives nothing.

A quote check only for a file of the controlling checkout was rejected.
It refuses a source that the user keeps outside the project, and a file in the working tree can differ from the commit that would name its revision.

A long text inside the crew state was rejected.
A large artifact stays outside the state, and a stored copy with its content identity fixes it as well.

A new planning item for a changed decision was rejected.
It cannot hold a dependent that is already running, and a new dependency on an item that an attempt has read is a conflict under ADR 0004.

## Consequences

An invalidated planning assignment must be accepted again, with a new record, so that the dependents it paused can resume.

An exact quote refuses words that were wrapped again or shortened, so the Operator quotes the exact bytes of its source.

A running dependent that must see a changed decision needs an attempt replacement, or a rework cycle after it submits.

A planning assignment that an earlier release accepted keeps no record.
The brief of its dependent says that it has no recorded decision, so an Operative does not read the absence as "no decision was needed".

ADR 0006 is amended: a requirement names its source by a stored copy, and its words must appear in that copy, for the answer to a question as well as for a planning decision.
