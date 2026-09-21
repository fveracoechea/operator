# The frontier is the only dispatch rule, and review holds the last crew slot

`operator work frontier` reads the dependency, ordering, and capacity rules and reports the assignments a crew may start now.
`operator work claim` recomputes the same frontier and refuses any assignment the frontier withheld.
The rules therefore have one owner, and a claim cannot take work that the reported frontier did not offer.

An assignment is dispatchable when it is executable, unclaimed, and every assignment it depends on is accepted.
Accepted completion is the only state that unblocks a dependent, so no work starts from an unreviewed result.

Queued review work is offered before production work.
Inside one kind, the order is the order the sources and their items were registered.

The crew limit defaults to three active agents and is set by `crew.maxActiveAgents`.
A limit of two or more reserves one slot for review, so a full production queue can never starve a queued review.
A limit of one reserves nothing and runs one assignment at a time.

Planning work is registered so dependencies resolve, and it is never dispatched.
A specification or a ticket states the planning boundary of each item.
A wayfinder ticket states it through its own type, where `research`, `grilling`, and `prototype` are planning and `task` is production.

## Considered options

Checking capacity only at dispatch was rejected.
The frontier would then report work that a claim refuses, which is two renderings of one rule.

A separate review queue with its own limit was rejected.
Review and production compete for the same Herdr agents, so one limit with a reserved slot describes the machine that actually runs them.

Unblocking a dependent on result submission was rejected.
A submitted result is not accepted completion, and a dependent built on it would rest on unreviewed work.

## Consequences

`operator work accept` records accepted completion in this release with no review precondition.
The review workflow adds its preconditions to that same transition rather than adding a second path to acceptance.

A registered source is fixed at the revision it was registered with.
Registering the same source at a different revision is a conflict that needs a decision, because assignment inputs stay fixed once they exist.
