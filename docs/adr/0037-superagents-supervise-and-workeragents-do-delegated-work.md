# ADR-0037: SuperAgents supervise and WorkerAgents do delegated work

## Status

Accepted - 2026-10-24.
Decided in #232 and completed by #233.
Planned, not yet implemented.

## Context

The product name also named its supervisor, while a group label and several worker names obscured the responsibility boundary.
Real sessions delegated reading, investigation, and planning as well as code and review.
Detailed work in the supervisor's conversation consumed context needed for coordination across projects.

## Decision

Operator names the product and its personal agentic tooling only.
SuperAgent names the supervisor and the person's point of contact.
WorkerAgent names an agent that receives delegated work and reports to its supervising SuperAgent.
Task descriptions are not separate roles or a closed list.
Herdr agent and agent session keep their runtime-process and conversation meanings.

Remove the former group vocabulary and its derived terms rather than retain aliases.
Use Operator state for stored workflow records and ready assignments for work that may start.
The rename applies to current prose and relevant CLI, JSON, database, private-code, plugin, and skill interfaces.
Product executable and plugin identifiers keep their product meaning.
The role skills become super-agent and worker-agent without old-name forwarding skills.
Retained ADRs use the current terms, and superseded records preserve their historical bodies.

The five rules of the person govern supervision.
A SuperAgent delegates detailed reading, investigation, implementation, review, research, triage, planning, and prototypes.
It can run coordination commands and communicate with other SuperAgents through Herdr without taking over worker tasks.
A PR merges only through the owner's guarded merge operation.
Unlanded work remains until the person authorizes its deletion.
Only a SuperAgent addresses the person.
The SuperAgent keeps context low, reads short reports, and opens details only for a coordination decision.

## Consequences

- This is a breaking vocabulary and interface rename, not a documentation-only alias change.
- Callers and Nix skill links need updates, and modified old-name managed skills require conflict resolution.
- Supervisors can coordinate many task kinds, but the assignment still needs an explicit completion contract.
- Delegation and short reports add handoffs in exchange for preserving supervisor context.

## Alternatives considered

- Spaced supervisor names and a generic agent role were rejected because the person's exact terms distinguish workflow roles from runtime processes.
- Retaining role aliases or the old group label was rejected because two active names preserve ambiguity.
- A prose-only rename or forwarding skill was rejected because live interfaces would retain the old vocabulary.
- Restricting workers to implementation and review was rejected because the person's work includes other tasks.
- Detailed work by the SuperAgent was rejected because that consumes the context needed for supervision.
- Automatic deletion of changed old-name skills was rejected because managed installation does not own user edits.

Related: ADR-0028, safe owned-skill replacement; ADR-0030, guarded PR merge; ADR-0033, report completion and authority; ADR-0034, profiles do not define worker roles; ADR-0014, one skill home and task-specific disclosure.
