# A result is checked against its authority limits at submit, and a change outside its worktree waits for a disposition

The brief of an Operative states its write paths, but a brief is text.
In a flow run by hand, an agent wrote a file outside its worktree, and one report said "no behavior change" when the change had some.
Nothing checked either one.
Operator cannot stop every host from writing, but it can read the checkout and the folders around it afterwards, as ADR 0007 already does for a reviewer.

A write path is a file or a folder, named from the repository root.
A folder covers everything under it, segment by segment, and the letter case counts.
Registration refuses a write path that is not in its one canonical form, and a production item with no write path.
A write path that an earlier release stored is read in its canonical form: each empty and `.` segment goes, and `..` takes out the segment before it.
A stored path with no final `/` stays a file, because only the final `/` names a folder.
A stored path with no canonical form, such as an absolute path, a glob, or a path that leaves the repository root, fails loudly, because a hold or a check that cannot read it could miss an overlap with no sign.
The crew frontier reads the same rule, so the check of a result and the check of an overlap cannot disagree about what "inside" means.

`operator attempt submit` checks a result before it records it.
It refuses a result when the commit shape of ADR 0015 is wrong, when the worktree holds work that is not committed, when the commit touches a file outside the write paths, when a behavior change names no recorded basis, or, for a code result, when its recorded checks do not show each command of the project gate as passed (ADR 0021).
Work that is not committed is refused because a check that passed on it is no proof for the commit that lands.
The files that Operator wrote into the worktree, and the path artifacts of a non-code result that lie inside the write paths, are not such work.
The commit touches a file when it adds, changes, or deletes it, and a rename touches both of its paths.
Submit reports every refusal at once, in a fixed order, and a check that could not run says so and never reports a pass.
A refusal leaves the attempt running, so the Operative that holds the context makes the fix.

A write outside the write paths is a security permission under ADR 0006.
Only a person widens the write paths, with one approval that names the extra paths and the assignment, bound to the write paths as registered.
That approval covers every attempt of the assignment, rework included, until the registered write paths change.
An answer never widens them.

Every submission lists its behavior changes, and an empty list is the explicit statement that there are none.
A behavior change is any difference, compared with the base, in what the changed code does for some input.
Each entry names its basis: the approved scope, one acceptance requirement, or one answered question whose answer is a requirement or a human answer.
An Operator decision is never a basis, because ADR 0006 puts visible behavior outside delegated authority.
Operator checks that the basis exists, and it cannot check that the basis covers the change.
So each axis of the review states that it read the list, and a missing or wrong entry is a blocker finding.

Before the agent starts, dispatch records a snapshot of the folder that holds the worktree and of the controlling checkout, and submit compares them again.
Each difference is an outside change, and it is recorded on the submission.
Submit does not refuse for it, because the scan cannot name the writer, and the Operative cannot undo a write that the user or another Operative made.
Acceptance blocks until the Operator disposes each outside change: explained, with a reason and the evidence, or removed, which a new scan proves.
Operator never deletes an outside change by itself, and one that touches a security permission goes to the user.

## Considered options

A write-path check by the reviewer was rejected.
It is prose, it costs a crew slot, and a comparison of two lists belongs in the CLI.

A write-path check at acceptance was rejected.
It finds the fault after the Operative has stopped, so every fix becomes a rework cycle.

Globs or pathspecs as write paths were rejected.
Two globs can overlap in ways that the frontier cannot decide simply, and two folder prefixes overlap exactly when one is a prefix of the other.

Write paths as free text compared by string prefix were rejected.
A path would then cover a sibling folder whose name starts with the same letters.

Rename detection was rejected.
Its answer depends on the file content, and the old path of a rename is a write too.

A check of the commit alone, with the working tree ignored, was rejected.
A recorded pass would then describe files that do not land.

A refusal at submit for an outside change was rejected, and so was an outside change that blocks nothing.
The first punishes the Operative for writes it did not make, and the second lets a recorded fact pass by silence, which ADR 0007 refuses.

The producer's own statement as the release of an outside change was rejected, for the reason ADR 0007 rejects the producer's word about its own checks.

An optional behavior change list was rejected, because silence would then mean "none".
A separate form for "none" was rejected, because the failure it addresses is a wrong "none", and only a reader catches that.

A comparison of the reviewer's own list with the producer's list was rejected.
Two correct lists of the same change can use different words.

An Operator decision as the basis of a behavior change was rejected, because ADR 0006 refuses an Operator decision on visible behavior.

A grant bound to the revision of the assignment was rejected.
That revision moves at every change of state, so a rework Operative would be refused for the file its predecessor was allowed to write.

## Consequences

A file that is written and deleted before submit is not seen.
Only a guard at write time catches it, and the host launch settings that could give one are not part of this decision.

The crew frontier reads the registered write paths plus every grant, because a grant can make two running assignments overlap.

A behavior change that nothing asked for now costs one question to the user before the Operative makes it.

Nothing checks the allowed commands or the network permission yet.
