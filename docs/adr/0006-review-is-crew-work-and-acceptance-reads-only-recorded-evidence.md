# Review is ordinary crew work, and acceptance reads only recorded evidence

`operator attempt submit` is the durable handoff of one result.
It fixes the assignment revision, the requirement revision, the acceptance requirements it was produced against, every artifact with its content identity, every check with its outcome, the known concerns, the decisions the Operative made, and the code revisions where there are any.
A path artifact is copied into a durable store at submission and verified against the identity the Operative stated, so the reviewer reads a fixed copy instead of a worktree another attempt may still change.

A submission moves the assignment to awaiting review and ends its attempt.
It is never accepted completion.
The ended attempt frees the crew slot it held, so a one-agent crew hands its only slot from the producer to the reviewer.

The submission registers its own review assignment.
Review is therefore ordinary crew work: the frontier offers it first, it is claimed and dispatched like any other assignment, and it holds one Herdr slot and its own worktree.
Its brief carries the fixed result, tells the reviewer to load the existing `code-review` skill, and requires both axes to run as native sub-agents of that reviewer's own host.
Those sub-agents read files and run the recorded check commands.
They never edit, commit, push, or rework, and they never take a Herdr slot or worktree of their own.

`operator review report` records the two axis reports, or the blocker that stopped the review.
The report names the submission identity it read, both axes appear exactly once, each sub-agent names the reviewer's own host, the two sub-agent windows overlap, and each axis states what it read.
A code result requires the diff, the requirements, and the checks.
A non-code result requires the artifacts, the requirements, the citations, and the provenance of each recorded answer.

A review report ends the review chain.
It is not a submitted result, so `operator attempt submit` refuses a review attempt and no review triggers another review.

A blocked review is a stopped review, not a verdict.
`operator attempt replace` returns it to registered, so the replacement reviewer reads the same fixed submission and reports it itself.
One review holds at most three attempts, so a failing review host escalates to the user instead of consuming the crew.

`operator review dispose` records what the Operator decided about each finding.
A finding is corrected, rejected with a reason, or deferred with a reason and a follow-up.
A blocker is never deferred, because deferring one would waive an approved requirement through technical judgment alone.

`operator work accept` is the only path to accepted completion, and it now reads the recorded evidence of production work.
It verifies the current ownership, the assignment revision, the exact submission, both axis reports, a disposition on every finding, no correction still waiting for rework, a passing outcome on every recorded check, and the pull request head the caller read against the head the review saw.
A stopped reviewer, a missing input, an unavailable review capability, a missing credential, a missing pull-request authority, a failed check, and a flaky check are each a recorded fact that blocks, never an absence that passes.

## Considered options

A separate `operator review accept` command was rejected.
Acceptance would then have two paths, and the one with fewer gates would win whenever a caller was in a hurry.

Launching the two axes as their own Herdr agents was rejected.
The user chose one Herdr review agent with native sub-agents, and three Herdr agents for one review would saturate a default crew of three.

Trusting the reviewer's word that the axes ran in parallel was rejected.
Each sub-agent records its own window, so a sequential pair is visible and is refused.

Letting the reviewer read the producer worktree was rejected.
That checkout keeps changing, and evidence that can change is not fixed evidence.

Copying the `code-review` skill into the review worktree was rejected.
Operator installs only the skills it owns, so a checkout with no review skill blocks the launch instead of receiving a copy Operator does not maintain.

Accepting a claimed assignment with no submission was rejected.
There would be nothing to bind the review evidence to, and acceptance would rest on the Operator's memory.

## Consequences

Rework is not in this release.
A finding disposed as corrected blocks acceptance with `rework_pending` until the rework workflow lands.

The sub-agent records are the reviewer's own report, as an acknowledgement is.
Operator does not run the other host's sub-agents, so it cannot observe them.
It records what the reviewer states, refuses a report that contradicts itself, and binds every report to the submission identity it read.
A live probe of the selected hosts is what proves the capability itself.

The pull request head is the head the Operator read, not a head Operator fetched.
There is no tracker boundary in this release, so acceptance compares the stated head against the reviewed head and nothing else.

A blocker may be rejected with a stated reason.
That is the Operator's delegated authority, and the reason is recorded beside the finding.
Only deferring a blocker is refused, because a deferral leaves the requirement unanswered while the result is accepted.

Review work that a source registered by hand carries no submission, so it accepts straight from its attempt.
Only a review this workflow created holds a review record, and only that record gates its acceptance.

The state version stays at 1.
The new tables are added to a file no release has shipped yet, and a state file that predates them is reported as unreadable rather than repaired in silence.
