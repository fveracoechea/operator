# ADR-0014: Both hosts use configurable start profiles

## Status

Accepted - 2026-10-24.
Decided in #231 and #233.
Implemented in #241.

## Context

A fixed implementer and reviewer list could not describe all delegated tasks.
The person used both OpenCode and Claude Code and wanted the same model with different thinking effort for supervision and work.
Changing device defaults also needed a clear boundary between running workers and new launches.

## Decision

Device settings define host and model defaults and extensible named start profiles.
Each assignment selects a profile and names its task instructions or skills in its brief.
Both OpenCode and Claude Code are supported.
The SuperAgent defaults to high thinking effort, and WorkerAgents inherit its host and model with medium effort unless a profile overrides those defaults.
An unsupported model or effort selection is an error without silent substitution.

The person can change host, model, effort, and profile settings through the CLI at any time.
Settings changes affect subsequent launches, including replacement workers, while running workers keep their launch settings.
Each launch records its resolved host, model, and effort along with release and skill identities.
Externally managed read-only settings remain protected.
Herdr supplies communication across hosts.

WorkerAgents can use native host subagents when a skill or workflow calls for them.
Those subagents stay under the parent assignment and the parent WorkerAgent remains responsible for their work and final report.
Independent scheduling, dependencies, or SuperAgent acceptance requires a separate assignment.

Operator does not install permission rules, pass a permission mode, or maintain an allow list.
Host permissions remain under the person's host configuration rather than an Operator approval machine.

## Consequences

- Both host integrations and their model and effort validation need maintenance.
- A replacement can launch with settings different from the worker it replaces, so every launch needs its own resolved record.
- Task profiles can grow without changing the set of worker roles.
- Native delegation has no independent Operator schedule or completion record.
- A host permission refusal needs attention through the worker's communication path rather than an Operator grant.

## Alternatives considered

- A Claude Code-only workflow and a closed implementer/reviewer profile list were rejected because the person's delegated work and host choices are broader.
- Silent model fallback was rejected because it changes an explicit selection without authority.
- Applying settings edits to running workers was rejected because it changes a launch already in progress.
- A separate Operator assignment for every native subagent was rejected because parent-owned delegation does not need independent scheduling.
- Operator permission lists and approval grants were rejected because host configuration owns that boundary.

Related: ADR-0008, both hosts receive owned skills; ADR-0009, readiness checks the configured host; ADR-0007, launch provenance; ADR-0013, task instructions and report responsibility; ADR-0011, resource selection; ADR-0015, reviewers use the selected host; ADR-0017, profiles do not define worker roles.
