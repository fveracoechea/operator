# One read-only command owns the coordination order, and a new owner adopts an attempt explicitly

`operator crew next` is the only schedule.
It reads readiness, the frontier order, dependency gates, review priority, capacity, pending acknowledgements, open questions, undisposed findings, unfinished tracker steps, and unfinished cleanup, and reports them as one ranked list of actions with the waits that hold the rest.
The Operator skill takes the first action, runs the command it names, and reads again.
The rules therefore keep one owner, and a session cannot hold a queue that disagrees with the state.

The order is declared once, in the crew state, as a list of action names.
Recovery comes before conversation, conversation before a pipeline step, and a launch last.
A session that finds an unsettled effect or an unadopted attempt therefore settles it before it starts new work.

The exit meaning answers what this session may do on its own.
An action that waits on a person is a blocker, so `0` means work to start now, `6` means nothing can advance and a bounded wait is next, and `3` means every open action needs the user.
That is why readiness is reported as an action rather than as a refusal: a project that is not ready is the user's decision, not a reason for the command to answer nothing.

`operator attempt adopt` is the step ADR 0005 left to this workflow.
A takeover replaces the ownership token, so every attempt the former Operator claimed stops being the current writer.
Adoption is the new owner's statement that it read what one attempt still holds, and it changes nothing about the work, the checkout, the brief, or the questions.
It runs only on settled effects and a live writer.

## Considered options

Reporting readiness as its own command and leaving the skill to combine it was rejected.
Two reads that the skill joins are two schedules, and the join is exactly the rule that has to have one owner.

Filtering launch actions out while readiness is unproven was rejected.
The CLI cannot know whether the user accepts an unverified project, and hiding the work would make the report disagree with the frontier.

Adopting an attempt automatically inside `operator crew own` was rejected.
A takeover happens when the former session is gone, so the new owner has not yet read what any of those attempts hold, and reconciliation has not run.

Adopting a stopped writer was rejected.
An attempt whose Operative is gone needs its partial work inspected, which `operator attempt replace` already does under its own approval.

## Consequences

`operator work frontier` stays.
It prints the order, the gates, and the capacity on their own, and `operator crew next` reports the same reading under `data.frontier`.

Every new named operation has to appear in the next actions, or a session will not find it.
The action names are a durable contract, held as a union type so a rename is a compile error.

The tracker step rule now has one rendering, which both `operator tracker show` and the next actions read.

A live probe is not implemented in this release, so a configured project reports `unverified` and the `prove_readiness` action stays listed.
That is honest, and the skill says to settle it with the user before a launch.
