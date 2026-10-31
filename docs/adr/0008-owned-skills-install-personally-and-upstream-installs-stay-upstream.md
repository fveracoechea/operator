# ADR-0008: Owned skills install personally and upstream installs stay upstream

## Status

Accepted - 2026-10-24.
Decided in #209, #232, and #233.
Implemented for owned skills in #242 and the delegated upstream install in #243.
Amended 2026-10-31: upstream installs cover several pinned sources and run with every owned install, and the separate upstream command is removed.

## Context

Device-level operation could not depend on skill copies committed in each project or left in a temporary package folder.
Nix consumers already owned their host links.
A custom upstream installer and ledger would duplicate the upstream tool's responsibilities.

## Decision

Operator-owned skill contents come from the running release and install once into the selected hosts' personal skill locations.
Both OpenCode and Claude Code are supported.
JSR and source installations make complete managed copies, including supporting content.
A device ledger permits replacement only of unchanged managed content, while changed or unrelated content is a conflict.
Matching content needs no write.

Nix consumers own their links to package skills.
Owned-skill installation on that path checks linked contents without changing host folders.
When a release renames a skill, it replaces an old-name managed copy only when the ledger proves that the copy remains unchanged.
There are no forwarding skills, and Nix users change their own links.

Operator delegates global upstream skill installation to an exact upstream installer version.
The release names a fixed list of upstream sources: Matt Pocock's skills repository, and single skill folders that the person chose from other repositories.
Each source resolves its own full repository commit before any installer runs.
A repository source selects every skill that Operator does not own, and a folder source selects only the skill in its folder, so another copy of that name elsewhere in the repository stays out.
Operator supplies explicit global scope, selected hosts, and a positive list for each source.
A name that two sources select, an owned name in a folder source, or a missing folder stops the install before any installer runs.
The upstream installer owns its global copies, links, lock record, and replacement behavior.
Operator keeps no second upstream-content ledger.

The owned-skill install is the one command that the person runs after each release install or update, so it also performs the upstream install.
An owned refusal stops the command before upstream work, and a content-only check performs no upstream work.
Running the install permits the upstream tool's replacement behavior, including its lack of a local-edit preview, and the command states that policy before upstream work.
Upstream installation remains available on Nix devices.

Skill readiness follows links and compares complete owned contents with the running release.
It checks that required upstream skills exist without requiring their independent revisions to match Operator.
Only upstream skills that Operator workflows use are required, so a personal skill that the person starts by name is not a readiness blocker.
It performs no host-precedence analysis or live loading probe.
The supervisor skill starts from the global CLI, and the worker skill starts from the supplied absolute brief reference.

## Consequences

- External package updates can require an explicit owned-skill install before content readiness passes.
- Content checks cannot prove that a running host loaded the expected skill.
- An upstream install can replace same-name destinations according to upstream policy, which the person accepts by running the install.
- An owned install needs network access to the upstream repositories, and an upstream failure fails the command after the owned copies are written.
- Adding or removing an upstream source is a release change, not a device setting.
- Nix ownership prevents automatic repair of missing or stale links.

## Alternatives considered

- Project copies and links into temporary source or package caches were rejected because they repeat setup or depend on an unstable installation path.
- Overwriting modified skills was rejected because Operator does not own those edits.
- A custom upstream preview, installer, and ledger were rejected because they duplicate a maintained upstream mechanism.
- Discovery-precedence analysis and live skill probes were rejected until an actual host-loading failure requires them.
- A separate upstream command beside the owned install was rejected because the person wants one step after each install or update, and two install paths drift.
- An install hook inside the package manager was rejected because Bun does not run an untrusted package's install scripts by default, and Nix builds have no network.
- Selecting a folder source's skill by name across its whole repository was rejected because those repositories hold more than one copy of some names.

Related: ADR-0002, skills use task-specific disclosure; ADR-0004, device ownership; ADR-0007, running-release authority; ADR-0009, static readiness; ADR-0014, both supported hosts need their skills; ADR-0017, role skill names and safe rename.
