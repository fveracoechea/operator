# ADR-0033: Missing review recovery records its authorization as steering

## Status

Accepted - 2026-11-16.
Decided in #416 under the delegated recovery scope.
Amends ADR-0020.

## Context

A live report promotion could associate a draft without recording its required internal review.
Recovery needed durable authorization and exact provenance without inventing an earlier review.
A new audit table required a schema migration, but the device's global idle guard correctly blocked that migration while the affected assignment remained open.
Making recovery depend on ending that assignment would destroy the workflow it needed to preserve.

## Decision

On the person's explicit instruction, missing-review recovery records a fresh system steering message and the missing reviewing state in one transaction.
The message instructs the assignment owner to stop implementation and hand the exact associated draft to a fresh reviewer.
Its immutable body records the authorizing attestation, original owner, assignment, PR, branch, worktree, pushed head, and authorization time.
The attestation is not a person-authored answer or a GitHub approval.
The system key cannot be sent through ordinary steering commands.

Recovery creates a genuinely pending message, not a fabricated acknowledgement or historical review activity.
Acknowledgement, replies, and closure retain the message body, so they do not erase the authorization receipt.
A malformed or incompatible existing system message blocks recovery rather than being replaced.
Exact retries reuse the receipt and never repeat a handoff.
Recovered handoffs revalidate their recorded authority and current safety conditions before destructive steps.

## Consequences

- Recovery works on the existing schema while ordinary migration guards remain unchanged.
- The steering message remains pending until its recipient acknowledges it or its supervisor closes it.
- Launch snapshots and prior review activity remain unchanged, and review starts at recovery time.

## Alternatives considered

A dedicated audit table was rejected because it prevented delivery to the live assignment that required recovery.
Weakening the global idle migration guard was rejected because repair does not authorize changing upgrade safety.
An external log was rejected because it could not commit atomically with the review.
Storing authorization in unrelated PR progress was rejected because feedback progress and a supervisory instruction have different meanings and lifecycles.

Related: ADR-0020, the fresh reviewer still owns the draft; ADR-0022, steering retains supervisory instructions; ADR-0007, recovery does not bypass release compatibility.
