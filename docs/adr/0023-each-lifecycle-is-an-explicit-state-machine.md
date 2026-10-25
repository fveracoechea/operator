# ADR-0023: Each lifecycle is an explicit state machine

## Status

Accepted - 2026-10-03.
Decided in #126.
Amended 2026-10-24: Preserve declarative and deterministic CLI control while limiting machines to the workflows retained in #231, #228, and #233.

## Context

Operator needed a declarative and deterministic process that guided agents and subagents through applicable next actions.
Workflow guards had spread across commands, and commands repeated rules about the same records.
Agents also performed mechanical steps by hand when the CLI lacked the corresponding operation.
The reduced workflow still needed predictable transitions without retaining machines for removed functions.

## Decision

The CLI owns Operator's workflow state machines, evaluates their guards, performs their mechanical steps, and returns applicable next actions.
The same state, event, and observed facts give the same transition, effects, or refusal.
Agents perform reasoning and assigned work, not a second implementation of the workflow protocol.

Each retained lifecycle has a closed set of states and events, an ordered transition table, and a pure decision over gathered facts.
The decision reads no database, network, Git repository, or clock.
The operation gathers facts and executes effects outside that decision.
The module that owns the record owns its transitions, and next actions read those states rather than reconstruct them independently.

The retained machines describe work sources, assignments with PR or report completion, review requests and rounds, and their required cleanup or transport effects.
Pure computations need no machine.
Host activity remains distinct from report submission, report acceptance, and PR merge.
Removed ownership, question, approval, tracker, gate, integration, and planning-record machinery does not return merely to fit this shape.

## Consequences

- A workflow change needs a change to the declared rules and the operations that execute them.
- Pure decisions permit tests without external tools, but those tests do not prove the effect integrations.
- Separate lifecycles share a decision shape, not a compulsory generic engine.

## Alternatives considered

- Agents interpreting the workflow and performing its mechanical steps were rejected because sessions can choose different steps from the same facts.
- Guard chains in each command were rejected because two commands can disagree on the same transition.
- One generic engine for every machine was rejected because the machines have different facts and effects and would need callbacks for each workflow.
- Retaining unused machines was rejected because their maintenance cost remains even when no session needs them.

Related: ADR-0011, one coordination answer reads these states; ADR-0026, state storage and transaction boundaries; ADR-0030, PR assignment lifecycle; ADR-0032, source lifecycle; ADR-0033, report assignment lifecycle; ADR-0035, review-request lifecycle.
