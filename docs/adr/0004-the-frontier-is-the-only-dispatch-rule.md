# The frontier is the only dispatch rule, and review holds the last crew slot

`operator work frontier` reads the dependency, ordering, write-path, and capacity rules and reports the assignments a crew may start now.
`operator work claim` recomputes the same frontier and refuses any assignment the frontier withheld.
The rules therefore have one owner, and a claim cannot take work that the reported frontier did not offer.

An assignment is dispatchable when it is executable, unclaimed, and every assignment it depends on is accepted.
Accepted completion is the only state that unblocks a dependent, so no work starts from an unreviewed result.

The frontier never offers a production assignment whose write paths overlap the paths that other work of the same source holds.
A production assignment holds its write paths from its first claim until it reaches accepted completion, and again from the moment it leaves accepted completion until it reaches it again.
Inside one reading, each assignment that the frontier offers also holds its write paths, in priority order, in the same way that it takes a crew slot, so one reading never offers two overlapping assignments.
An assignment that has not started holds nothing, so a ready assignment never waits behind an earlier one that waits on something else.
The frontier withholds an assignment whose write paths overlap held paths, and it names each holder and each overlapping pair of paths.
Review and planning work hold no write paths, because neither makes a commit.
Two write paths overlap by the one rule that ADR 0018 records, and the frontier uses that same rule.

The frontier reads the effective write paths of each assignment: its registered paths, and every current grant of more paths to that assignment, which ADR 0018 also records.
A grant that makes two started assignments overlap stops neither of them, because both already started from their bases.
The grant changes only what the frontier offers after it.
The approval request for such a grant names each started assignment of the source whose held paths the grant overlaps, so the user accepts the risk of a refused patch with that knowledge.

The hold exists because a code result is one commit on the base of its dispatch, as ADR 0015 records.
Two results that change one file from the same base can combine with no conflict and still change a patch, and acceptance refuses a changed patch after its review is already done.
The hold ends at accepted completion, because the integration branch then holds the commit, and the next dispatch starts from that branch.
A commit that is on the integration branch but not yet accepted still holds its paths.

The hold applies inside one source, because each source has its own integration branch.
Work of another source never starts from that branch, so a hold across sources would stop parallel work and prevent no refusal.
Two sources that change one file meet when their pull requests merge, and the frontier does not read that.
Work that must be done in two steps around another assignment is two items with a dependency between them.

Queued review work is offered before production work.
Inside one kind, the order is the order the sources and their items were registered.

The crew limit defaults to three active agents and is set by `crew.maxActiveAgents`.
A limit of two or more reserves one slot for review, so a full production queue can never starve a queued review.
A limit of one reserves nothing and runs one assignment at a time.

Planning work is registered so dependencies resolve, and it is never dispatched.
A specification or a ticket states the planning boundary of each item.
A wayfinder ticket states it through its own type, where `research`, `grilling`, and `prototype` are planning and `task` is production.

The Operator resolves planning work itself, so planning work reaches accepted completion with no attempt.
What that acceptance records, and how it reaches the dependents, is in ADR 0019.
Executable work reaches it only from the attempt that holds the assignment.
Without that, a task blocked by a research ticket could never start, because the research ticket could never be claimed.

## Considered options

Checking capacity only at dispatch was rejected.
The frontier would then report work that a claim refuses, which is two renderings of one rule.

A separate review queue with its own limit was rejected.
Review and production compete for the same Herdr agents, so one limit with a reserved slot describes the machine that actually runs them.

Unblocking a dependent on result submission was rejected.
A submitted result is not accepted completion, and a dependent built on it would rest on unreviewed work.

An overlap that the frontier only reports, and that the Operator skill applies, was rejected.
The skill would then hold a second schedule, which ADR 0011 rejects.

No overlap rule, with each conflict found at integration, was rejected.
A patch can change with no conflict, so the waste shows only at acceptance, after a production run and a review run.

A phase split inside one attempt was rejected.
The Operative would stop, wait for the other result, and continue on a new base, but a code result must be one commit on the base of its dispatch.

A dependency on part of an assignment, for some of its paths, was rejected.
The paths it waits for are not in its base, and it adds a second kind of dependency that the frontier, the claim, and the cycle check must each read.

A hold across every source of the crew was rejected.
It stops parallel work and prevents no refusal, and a hold that ends when a pull request merges needs a tracker read that the frontier never does.

A hold by every earlier assignment that is not accepted, started or not, was rejected.
A ready assignment would then wait behind one that waits on a dependency.

Ending the hold at result submission was rejected.
The next dispatch would start from a base that does not hold the commit.

Stopping or refusing a grant that makes two started assignments overlap was rejected.
The grant exists because the work needs the path to finish, and the user who approves it is the one who can accept the risk.

An override that turns the hold off for one item, and a folder kind that only adds files, were rejected.
A narrow file path is the escape: for example, the name of a new file can be chosen before the work.

## Consequences

Broad write paths make the work of a source run one assignment at a time.
Narrow write paths are how a source gets parallel work, and the registration plan reports each overlapping pair of items that no dependency orders, so the user can narrow the paths before registration.
That report reads only the registered paths, because a grant comes after registration.

`operator work accept` records accepted completion in this release with no review precondition.
The review workflow adds its preconditions to that same transition rather than adding a second path to acceptance.

Each assignment is fixed at the source revision it was registered with, because assignment inputs stay fixed once work reads them.
A new registration may add items.
A new source revision, and a changed item that no attempt has read, are recorded only behind an approval, as ADR 0016 records.
A changed item that an attempt has read, including a change to its dependencies, is a conflict that needs a decision.

One `kind` field carries both the planning boundary and the dispatch priority, so review work is always executable.
That is deliberate for this release: review work is produced by the review workflow, and planning review has no meaning yet.
