# ADR-0019: Unthrown separates operational failures from defects

## Status

Accepted - 2026-10-25.
Decided in #261 by the person's explicit selection.
Production code adopts unthrown, and the ADR-0018 lint policy from #237 enforces its rules.

## Context

Workflow operations needed closed expected failures without treating programming defects as ordinary errors.
The comparison exercised the same merge and review operations with plain unions, neverthrow, Effect values, the Effect runtime, and unthrown.
Unthrown preserved a separate defect channel without a scheduler and supplied Oxlint diagnostics that could guide coding agents.
Its Drizzle integration supported PostgreSQL rather than the selected SQLite database, and its Standard Schema bridge exposed a Zod rejection limit.

## Decision

Operator uses unthrown Result and AsyncResult for errors as values because its combinators keep expected operational failures separate from unexpected defects.
Operational failures remain closed owner-defined types with useful diagnostics.
Workflow refusal, uncertain external application, and interruption retain their own meaning, and defects do not grant retries or erase pending obligations.
The command boundary handles defects and owns public formatting and exit status.

All supplied unthrown Oxlint rules are enabled as errors, including the opt-in rules.
Exact dependency pins and reviewed upgrades define the supplied rule set rather than an unreviewed moving upstream default.
The checks provide guidance at common mistakes, not proof that every Result is consumed.

Operator does not use unthrown's Drizzle or Zod and Standard Schema integrations.
Database queries and helpers use core boundary constructors instead.
Async foreign calls can use fromPromise with a thunk so qualification covers synchronous invocation throws and promise rejections.
Qualification distinguishes modeled failures from defects rather than converting every exception into a domain error.
Synchronous work can use fromThrowable without making SQLite write transactions asynchronous.
The state owner rolls back both Err and Defect outcomes after writes.

Import unthrown directly rather than maintain a forwarding Result framework.
Workflow guards, evidence, recovery, and retry policy remain with their owners.
Only plain domain data crosses the persistence boundary, not library instances or runtime descriptions.

## Consequences

- Callers must account for a third runtime state, since not-Ok does not imply Err.
- AsyncResult starts work eagerly, so dependent work must start in sequencing callbacks rather than sibling constructors.
- Syntactic lint checks miss imported producers, dropped chains, and some aliased types, even with every rule enabled.
- Lint adoption must reconcile deliberate exception boundaries under the enabled no-throw policy rather than silently disable that rule.
- Without integration packages, the state owner must implement and test its own SQLite rollback and error translation.

## Alternatives considered

- A plain discriminated union avoided a dependency but left composition helpers and agent guidance to Operator.
- Neverthrow with ordinary Promise was sufficient for the operations, but callback defects could reject and its demonstrated Oxlint result-consumption coverage was weaker.
- Effect's lightweight Result did not provide a demonstrated advantage for these callers.
  Its runtime added services, scopes, and scheduling that the sequential operations did not need.
- Unthrown's database and validation integrations were rejected because their supported boundaries did not match the selected database or the required rejection handling.

Related: ADR-0003, owners retain their transition and retry policy; ADR-0006, SQLite transactions and persistence boundaries; ADR-0018, checked lint adoption with exact pins and fixes.
