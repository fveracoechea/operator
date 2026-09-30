# A source is read from the tracker and never created by Operator

`operator work register` reads a work source from its tracker.
A specification and a wayfinder map are a parent issue with its sub-issues, and a ticket is one issue.
Operator never creates an issue.
A person or a planning skill such as `to-tickets` creates the issues and their links, and that skill asks the user to approve the breakdown before it publishes.

The tracker holds the structure: the items of the source, their order, their dependencies, and the approved text of each one.
The Operator supplies only what the tracker does not hold: the acceptance requirements, the permissions, the fixed inputs, and the planning boundary of a specification or ticket item.
Its input names each item by its issue, and an input that names an issue outside the source, or leaves one out, is refused.
A wayfinder item takes its planning boundary from its type label, and the input cannot contradict it.
The approved scope of an item is its issue title and body as read, and the input cannot replace it.

An item is named by its repository and its issue number, because a sub-issue can live in another repository.
A source is named by its parent issue in the same way, so one issue is only ever one source.
An executable item in another repository is refused, because its commit cannot land on the one integration branch of the source.
A planning item there is allowed, because it makes no commit.

The item order is the stored sub-issue order, and it only breaks ties in the frontier.
A dependency is a blocking link.
A blocker that is an item of a registered source becomes a dependency on that assignment.
A closed blocker gates nothing, and a closed sub-issue is not registered.
An open blocker that no registered source holds is refused, because Operator cannot see when it is done.
A parent with no sub-issues is refused, and so is a read that did not cover every sub-issue and every blocker, because an incomplete read is a gap and not a proof of absence.

The source revision is the content identity of the parent title and body.
Each assignment also records the content identity of its own title and body.
The issue state and the comments are outside both, because Operator itself comments on and closes the issues it registered.

Registration is deterministic: the same tracker content and the same input give the same registration.
Keys are lowercase, because GitHub names are case-insensitive.
A recorded item is matched by its issue identity, so a renamed repository does not make a second item.
Blocker sets are sorted, and a carriage return before a line feed is removed before a content identity is taken.
Every refusal is reported at once, in a fixed order, and the output holds no value that changes between runs.

A registration is previewed first.
The preview changes nothing, and it reports every item it would add, update, or keep, every satisfied blocker, every refusal, and a registration plan revision.
That revision is the content identity of the canonical read and the input.
The registration reads again and refuses if the revision differs, so what is recorded is exactly what was previewed.

Only a new registration reads the tracker again.
`operator crew next` never reads the tracker, because it runs on every turn and changes nothing.
A new read adds each new open sub-issue.
A changed parent body is a new source revision, and a changed item that has no attempt takes its new content.
Both need an approval bound to the registration plan revision.
Each recorded assignment keeps the source revision it was registered under, so work that already started is not changed.
A changed item that has an attempt or is accepted is refused, because its writer read the old text, and the change goes in a new sub-issue.
A recorded item that the read no longer finds is refused.
On a new read, the input names only the new and changed items.

## Considered options

Operator creating the child issues from a specification was rejected.
The planning skill already does this behind the user's approval of the breakdown, and a second creator would duplicate both.

A hand-written registration file that holds the whole structure was rejected, and that path is removed.
Its structure is a copy of the tracker that an agent types, and a copy drifts from what it copies.

A command that writes a draft registration file from the tracker was rejected.
The tracker can change between the draft and the registration, and nothing would show it.

Execution fields parsed from sections of each issue body were rejected.
The planning skill does not write those sections, and Operator does not edit a skill it does not own.

A fourth source kind for a parent issue was rejected.
A split specification and a wayfinder map have the same shape on the tracker, so one reader serves both.

A revision over the whole structure was rejected.
Every new ticket on a map would then be a new revision of its source.

A wayfinder source that takes a new body with no approval was rejected.
A map body also holds the destination and the notes, which change the work.

A refusal for a blocker whose position is after its dependent was rejected.
The frontier waits on the dependency anyway, so the refusal would only make the user reorder issues.

## Consequences

A source registered by an earlier release keeps its keys, and its bindings gain the repository of the source.
A new read of such a source is refused, because it has no parent issue.
The user finishes its work, or registers the parent issue as a new source.

Each change to a map body needs one approval before the next tickets of that map are registered.

Withdrawal of a registered assignment is not decided here, so a sub-issue removed from its parent stops the next registration of its source.

ADR 0004 is amended: a new source revision is no longer a conflict by itself, and an item that no attempt has read can take new content behind an approval.
