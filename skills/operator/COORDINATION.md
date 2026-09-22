# Coordinating a crew

Read this before you start work, and again on every turn that changes the crew.

## One command answers what to do next

```sh
operator crew next --claude --json
```

Name the installation targets the same way setup does, and the hosts you are about to launch.
The command writes nothing.

It answers with:

- `data.actions`, in the order to take them. Each action names its command, its subject, and the record revision to state.
- `data.waits`, which say what is running and what has not answered yet.
- `data.readiness`, the readiness verdict of this exact selection.
- `data.frontier`, the order, the dependency gates, the review priority, and the capacity the actions come from.
- `blockers`, which is what you bring to the user.

The exit code says what this session may do on its own.

- `0`: at least one action needs nobody else. Take the first one.
- `6`: nothing can advance now. Wait.
- `3`: every open action waits on a person. Bring the blockers to the user.

## Refresh, act, refresh

Run `operator crew next` again after every command that changes the crew.
A stale reading is the fastest way to dispatch work that another step already took.

Take the first action the list offers.
Run its command with a new request identity, and state the revision the action reported.
Each command checks its own preconditions again, so an action that is no longer valid is refused instead of performed.

Never reorder the list, and never keep a second list beside it.
An action you expect and do not see is a gap in the CLI.
Report that gap to the user instead of working around it.

## Readiness comes first

`prove_readiness` is reported before every crew action while this selection is not ready.
Do not launch an Operative while it is listed.
Settle it with the user.
If the user decides to continue without proven readiness, say so in your report and name what is unproven.

## Waiting

Exit 6 means nothing you can run will move the crew.
Wait on one of the agents `data.waits` names, and bound the wait.

```sh
herdr agent wait <agentName> --timeout 300000
```

Read `data.waits` for the agent name.
A wait is read-only.
Never send keys, submit a prompt, start an agent, or create a checkout by hand.

Run `operator crew next` again when the wait ends, whatever its outcome.
A wait that timed out proves nothing.
It is never evidence that an Operative stopped, and never a reason to send a brief again.

## Independent work continues

One blocked assignment holds only itself.
The next actions already leave out what waits, so every action you are offered is work that can move.

A question holds the assignment that raised it.
Its `independentWork` field says what continues without the answer.

Work stops for exactly four things, and the CLI names each one:

- a missing approval,
- an external effect that never proved an outcome,
- a conflict,
- a recovery that did not succeed.

None of them is repaired by hand.

## Capacity and priority are not yours to set

The crew limit comes from `crew.maxActiveAgents` and defaults to three.
A limit of two or more holds one slot for review.
Queued review is offered before new production work.

You do not choose what starts.
`data.actions` offers `claim_assignment` for exactly the work the frontier allows, in the order it allows it.

## Mixed hosts

The Operator host and the crew host are resolved field by field.
Read [READINESS.md](READINESS.md) for that order.

One dispatch may name its own crew host and model.

```sh
operator attempt dispatch --request <id> --owner-token <token> --attempt <id> --commit <sha> --crew-host opencode
```

The launch records that selection, so the two Operatives of one crew can run on different hosts.
A recovery restores the recorded host, never the current default.
A session override reaches new launches only.

## Reporting to the user

Report the results, the decisions you took, and the blockers that remain.

Name each decision as your own.
An Operator decision is not a human answer.
A summary of something the user said earlier is not a human answer either.
`operator question show` prints the recorded authority of every answer, so use those words.

Quote a person with their exact words.
State your reading of those words separately.

Name every blocker that is still open, and say what you need from the user to clear it.
