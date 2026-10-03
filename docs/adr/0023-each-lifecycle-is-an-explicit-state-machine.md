# ADR-0023: Each lifecycle is an explicit state machine

## Status

Accepted - 2026-10-03. Decided in #126, first applied in #128.

## Context

Operator records many things that move through a lifecycle: an assignment, an attempt, a landing, an integration branch, a gate run, a review, an approval, a stack publication, a rebase, a recall, a tracker step, a question, and a cleanup.
The rules of each lifecycle were spread over the commands that moved it.
Each command held its own chain of refusal guards, two commands that moved the same record repeated the same frame, and the reader of the coordination order derived a state again from the recorded columns.
The chains grew so long that a complexity limit could be met only by cutting them into small helpers that each hid one guard, and a new command could drift from the rules of the commands beside it.

## Decision

Each lifecycle of one recorded thing is one explicit state machine, owned by the module that owns the recorded thing. A machine has five parts:

1. **States.** One closed set of state names. The recorded status is one of these names. No state is derived from a mix of nullable columns when one name can say it.
2. **Events.** One closed set of the commands and observations that can move the thing, such as a command, a pull request that merged, or a gate result.
3. **One transition table.** Data, not code branches: for each event, the states it may start from, the guards in order, and the next state. A guard that fails gives the refusal code. A long chain of guards is rows of the table, never a set of small pass-through helpers.
4. **One pure decision.** `decide(state, event, facts)` returns the next state with its effects, or the first refusal. It reads no Git, no GitHub, no crew state, and no clock. The caller gathers the facts first.
5. **Effects outside the decision.** The interpreter gathers the facts, calls the decision, writes the next state and its effects in one transaction, and then runs the outside effects through the recoverable steps of ADR-0005. When a fact is costly, or is itself the outcome of an outside effect, the decision names the next fact it needs, and the interpreter gathers it and decides again. So reads and effects happen in the order of the table, and no effect runs before a guard that would refuse it.

A machine is reached through the interface object of its module. While no other module needs it, the machine stays private to its module, and callers reach it only through the actions of that interface object. When another module needs it, the interface object exposes it, and that module calls the machine instead of testing status values itself.

The command line stays a thin interpreter: it parses the arguments, calls the module, and prints. The read-only command that owns the coordination order (ADR-0011) reads the states of the machines and does not derive them again.

A thing with no lifecycle gets no machine: a pure computation, such as a registration plan, stays a function.
A machine never changes a refusal code, their order, a field of the JSON output, the meaning of a recorded column, or a command flag. A change of state names needs a crew state migration.

The first two machines are the cleanup and the question:

- **Cleanup.** One record for each cleanup kind, process closure and worktree removal, with the states `pending`, `blocked`, `failed`, `uncertain`, and `done`, and the events close and remove. Each kind has its own ordered guards, and the preserve, stop, and remove outcomes are rows of the table. A retention hold is a second small machine with the states `held` and `released` and the events hold and release. The coordination order reads the owed cleanup from the machine.
- **Question.** The states `open`, `answered`, `delivered`, `resolved`, and `withdrawn`, and the events raise, revise, answer, escalate, deliver, and acknowledge. An event on a question that is not recorded is refused by the read that finds no row, before any guard runs.

## Consequences

- The refusals of one lifecycle are read in one table, and they can be tested with no database.
- ADR-0010 and ADR-0006 stay true. The cleanup and question machines record the same rules in one place.
- The other lifecycles move to this shape one at a time. Each such change updates the ADR whose names it touches.

## Alternatives considered

- **Keep the guards in each command and only cut long functions into helpers.** This meets the complexity limit, but each helper hides one guard behind a name, the refusal order spreads over many places, and two commands that move the same record still drift.
- **One generic engine that runs every machine.** The machines differ in their facts and their effects, so a shared engine needs callbacks for each one. Only the shape is shared: each machine has its own table and its own decision.
- **A state column for each derived lifecycle.** Where a closed set of derived state names already says the state, a column adds a migration for no gain. The derived set is the state of the machine.

Related: ADR-0005 (the recoverable steps that run the effects), ADR-0006 (the question rules), ADR-0010 (the cleanup rules), ADR-0011 (the coordination order reads the machine states).
