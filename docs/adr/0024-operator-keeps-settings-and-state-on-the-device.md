# ADR-0024: Operator keeps settings and state on the device

## Status

Accepted - 2026-10-24.
Decided in #199 and #202.
Supersedes ADR-0001.
Planned, not yet implemented.

## Context

Project-local setup put coordination settings and records in every checkout and copied them into worker worktrees.
That made a personal tool require repository edits and repeated installation work.
The person also managed settings through Nix, where replacing a read-only link would take control from its owner.

## Decision

Operator keeps all its settings and state at device level and requires no project setup edits.
Settings and state use separate XDG roots, with the same convention on Linux and macOS.
An explicitly set relative root is an error rather than a reason to fall back.
There is no third cache or runtime root and no separate Operator-home override.

One device settings document applies to all registered projects.
Operator supports externally managed read-only settings, permits inspection, and refuses edits rather than replace the owner's link.
Generated editor support is optional when its destination is read-only.
One owner resolves Operator paths, and one validated environment boundary supplies environment values to the application.
Tests supply isolated roots and never use the person's real state.

Registration replaces project setup because it records device state without changing project instructions or ignore rules.
Legacy checkout-local Operator state is not migrated or deleted by the new release.
The person must finish that work with the old release before removing its old folder.

## Consequences

- Device settings affect all projects, so projects cannot pin their own coordination settings.
- Externally managed settings require changes through their external owner rather than the settings editor.
- The breaking change leaves old local work under the old release instead of attempting an uncertain conversion.
- Central path and environment ownership adds a boundary that tests must use explicitly.

## Alternatives considered

- Keeping setup plans and repository-local configuration was rejected because registration needs no repository writes and a reversible device record does not need that protocol.
- Native macOS folders were rejected in favor of one XDG convention on both platforms.
- Silent path fallback and replacing read-only links were rejected because they hide invalid configuration or take over user-managed content.
- Automatic legacy-state migration was rejected because the device workflow is a breaking change, not an adoption of the former local machinery.

Related: ADR-0001, historical setup protocol; ADR-0025, explicit device registration; ADR-0026, shared state storage; ADR-0028, personal skill installation; ADR-0031, device-state briefs; ADR-0038, enforced environment ownership.
