# ADR-0007: One running release serves the device and migrates state

## Status

Accepted - 2026-10-24.
Decided in #199, #205, #206, #208, and #228.
Amended 2026-10-26 in #256: source delivery shares the release commit but has no artifact identity.
Implemented for global JSR and source delivery, automatic migration, and global-command readiness in #245 and #256.
Implemented for Nix delivery in #257.
Implemented for the stable global Herdr plugin in #247.

## Context

Every project on a device needed the same CLI and workflow instructions.
Global package locks also changed when unrelated tools were installed.
Version-specific Herdr paths stopped working after temporary installations disappeared.
State compatibility still needed a safe, deterministic update path.

## Decision

The running installation is the release authority for the device.
Bun, Nix, or the person updates that installation externally.
An exact JSR version, a Nix flake, and repository source at a full commit deliver the same release from the same commit.
JSR and Nix also share the built artifact and its identity.
Source delivery runs the source at that commit without an install-time build, so its identity is the commit alone.
An installation that does not pin an exact version or a full commit is a readiness blocker, because a later package update could move the device release.
The CLI, owned skills, and fixed migrations form one matched release.

Nix builds the shared release artifact with locked dependencies through bun2nix and the release's pinned Bun.
It does not compile a different standalone program or retrieve dependencies at runtime.
The package supports arm64 macOS and x86-64 Linux.
Consumers wire its read-only skills through their own Nix configuration, without an Operator Home Manager module.
JSR global delivery supplies a launcher because the registry does not retain the package binary declaration.
The launcher names the package manager's stable global package location and no release, so an update in place changes what runs without changing the command.

Every command passes through shared compatibility checks before its handler.
Matching Drizzle migration history proceeds, an older matching history applies shipped migrations in order, and newer, conflicting, or unsupported history refuses.
The CLI never generates migrations from the live device.
Migration waits for device-wide idle work and any migration-specific blockers, verifies a snapshot, and protects the period from snapshot through migration against concurrent writes.
A failed backup or migration stops the original command before its handler.
Concurrent commands recheck compatibility under that protection.

The latest three verified migration backups remain, and older backups are removed only after success.
Failed migrations keep their backup.
Launch records retain release and skill identities without copying Operator lock data into project worktrees or fingerprinting the shared global Bun lock.

Herdr uses the global command rather than a retained release-specific binary path.
Readiness refuses a global command that does not run the running release.
Its plugin manifest lives in stable device state, and its hooks call that command.
The plugin forwards agent activity and worktree-creation events to the CLI.

Publication is automatic after the version change merges and that commit passes quality checks and release smoke.
Published tags and versions are immutable, and a delivery retry supplies missing delivery only.
The pinned official JSR client uses short-lived release credentials, with Deno confined to publication tooling rather than the Operator runtime.

## Consequences

- An installation update applies to every project, so incompatible state can block even an otherwise unrelated command.
- A command can wait for device-wide migration preconditions before it performs its own work.
- Nix must preserve the common artifact identity and maintain the runtime packaging for both supported systems.
- The latest backup can be as old as the last schema migration.
- Stable plugin registration and global-command discovery must work independently of installation paths.

## Alternatives considered

- Per-project release records and explicit migration adoption were rejected because they duplicate the authoritative running installation and require a separate manual step.
- An unprotected migration on first read was rejected because concurrent writes and an unverified backup can lose state.
- A global package lock as the release fingerprint was rejected because installing an unrelated package changes it.
- A compiled Nix binary, a runtime source wrapper, and fetching the same commit's published tarball by hash were rejected because they break common-artifact identity, introduce runtime network installation, or require a self-referential publication hash.
- Repeated publication over an existing tag or version was rejected because immutable content cannot be replaced on a retry.
- A stored publishing token or custom registry client was rejected in favor of short-lived credentials and the registry's maintained client.

Related: ADR-0006, migration history and database protection; ADR-0008, installation uses the running release's skills; ADR-0009, startup compatibility is distinct from readiness; ADR-0012, source prune does not delete migration backups; ADR-0014, launches record resolved settings; ADR-0015, review worktrees use stable global-command hooks.
