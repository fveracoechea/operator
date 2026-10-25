# ADR-0009: Readiness checks static prerequisites without live probes

## Status

Accepted - 2026-10-24.
Decided in #202, #209, #231, and #233.
Planned, not yet implemented.

## Context

Synthetic capability checks needed agent launches, evidence storage, and resource cleanup before real work could run.
Actual sessions needed a cheaper check of prerequisites.
Missing commands, authentication, and skill files still caused preventable launch failures.

## Decision

Readiness observes current static prerequisites without launching agents or retaining live evidence.
It checks GitHub CLI availability and authentication, Herdr availability, and the configured host rather than a compulsory single host.
Required owned skills must match the running release, and required upstream skills must exist.
The check does not claim to prove provider compatibility, host termination, or live skill loading.

Database compatibility and integrity protections belong to state storage and command startup.
Failures of real external calls remain explicit errors.

## Consequences

- A statically ready device can still fail on its first real host or provider call.
- Readiness is cheaper and needs no synthetic resource cleanup or separate probe approval.
- Both supported hosts need their executable and skill checks maintained.

## Alternatives considered

- Keeping live probes and recorded capability fingerprints was rejected because their state and cleanup cost did not earn a place in the observed workflows.
- A saved ready flag was rejected because current tools and skill contents can change.
- Claiming live capability from file presence was rejected because filesystem evidence proves only the stated static facts.

Related: ADR-0008, filesystem skill checks; ADR-0006 and ADR-0007, database protection; ADR-0014, configured host selection.
