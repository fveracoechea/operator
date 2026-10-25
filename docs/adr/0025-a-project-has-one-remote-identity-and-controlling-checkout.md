# ADR-0025: A project has one remote identity and controlling checkout

## Status

Accepted - 2026-10-24.
Decided in #203.
Planned, not yet implemented.

## Context

Two clones of one repository needed to share device state without becoming two projects.
Herdr resources still needed one known checkout and workspace.
Remote names could describe forks, and a directory alone could not identify a repository after a move.

## Decision

A registered project has a canonical lowercase GitHub owner and repository identity and one real controlling-checkout path.
Registration uses the sole GitHub remote or an explicit repository that matches one of several GitHub remotes.
A remote name has no special authority, and a repository without a GitHub remote cannot register.

Registration is explicit and repeatable, creates the device database when needed, and writes no repository content.
The controlling checkout must be a main, non-bare checkout.
Project commands resolve from the real Git top level, so subdirectories work and recorded worker worktrees resolve to their own assignment.
An unrecorded clone cannot silently become the controlling checkout.
Device-wide review operations locate their project from the PR repository instead of the caller's directory.

A project can move to another clone with the same identity only when it has no open source.
Removal also requires no open source, deletes project records and device-state files, and touches no checkout, worktree, or branch.
The SuperAgent removes a project only on the person's explicit instruction.
A repository rename or transfer does not silently change the recorded identity.

## Consequences

- An otherwise valid clone can refuse project commands and direct the caller to the controlling checkout.
- A changed repository identity needs explicit re-registration when open work has ended.
- Project removal destroys local history, even though the repository and its resources remain.
- A failed file cleanup after record removal must remain recoverable rather than disappear as a successful removal.

## Alternatives considered

- Trusting only the conventional default remote name was rejected because a fork can use that name.
- A checkout for each source was rejected because every operation would need another checkout-selection rule.
- An Operator-owned clone was rejected because the person would not see work in their own checkout.
- Implicit registration was rejected because an ordinary command would then make a hidden state change.
- Keeping old state after removal was rejected because a later registration could discover a second source of truth.

Related: ADR-0024, registration replaces project setup; ADR-0026, the device database stores project identity; ADR-0031, worktree lookup scopes worker commands; ADR-0035, reviews use the PR repository's workspace.
