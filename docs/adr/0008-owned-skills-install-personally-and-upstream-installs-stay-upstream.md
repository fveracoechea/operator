# ADR-0008: Owned skills install personally and upstream installs stay upstream

## Status

Accepted - 2026-10-24.
Decided in #209, #232, and #233.
Implemented for owned skills in #242 and the delegated upstream install in #243.

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

Operator delegates global Matt skill installation to an exact upstream installer version and a resolved full repository commit.
It supplies explicit global scope, selected hosts, and a positive list of upstream skills excluding Operator-owned names.
The upstream installer owns its global copies, links, lock record, and replacement behavior.
An explicit upstream install permits that tool's replacement behavior, including its lack of a local-edit preview.
Operator keeps no second upstream-content ledger, and owned names are the only exclusions.
Upstream installation remains available on Nix devices.

Skill readiness follows links and compares complete owned contents with the running release.
It checks that required upstream skills exist without requiring their independent revisions to match Operator.
It performs no host-precedence analysis or live loading probe.
The supervisor skill starts from the global CLI, and the worker skill starts from the supplied absolute brief reference.

## Consequences

- External package updates can require an explicit owned-skill install before content readiness passes.
- Content checks cannot prove that a running host loaded the expected skill.
- An upstream install can replace same-name destinations according to upstream policy, which the person accepts by requesting it.
- Nix ownership prevents automatic repair of missing or stale links.

## Alternatives considered

- Project copies and links into temporary source or package caches were rejected because they repeat setup or depend on an unstable installation path.
- Overwriting modified skills was rejected because Operator does not own those edits.
- A custom upstream preview, installer, and ledger were rejected because they duplicate a maintained upstream mechanism.
- Discovery-precedence analysis and live skill probes were rejected until an actual host-loading failure requires them.

Related: ADR-0002, skills use task-specific disclosure; ADR-0004, device ownership; ADR-0007, running-release authority; ADR-0009, static readiness; ADR-0014, both supported hosts need their skills; ADR-0017, role skill names and safe rename.
