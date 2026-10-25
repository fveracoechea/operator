# ADR-0018: Type-aware oxlint owns code policy without duplicate checks

## Status

Accepted - 2026-10-24.
Decided in #200 and #201, with environment ownership resolved in #202.
Amended 2026-10-25: #261 adds every unthrown Oxlint rule, and #237 adds async correctness, unsafe-data checks, and a classic complexity ceiling of 14.
The base lint policy is implemented in #237.
Environment ownership remains planned for its device-settings slice.

## Context

The rule survey found useful defect checks that Operator did not yet enable.
Some imported policies duplicated existing module checks or depended on application concerns absent from this CLI.
Separate dependency-cycle and policy-review records would maintain two answers about facts the lint configuration or lock already held.

## Decision

Operator adopts the selected built-in and custom oxlint checks, including type-aware checks, as errors together with their fixes.
Exact dependency pins make tool upgrades visible and reproducible.
There is no violation baseline or suppression campaign that leaves the newly selected policy unenforced.
Test-specific exceptions remain explicit rather than weakening the production checks.
The unthrown rules selected in ADR-0019 join this policy as errors, including every opt-in rule.
Promise callbacks must match the caller's completion contract.
Unsafe data flows require boundary validation rather than assertions, including in tests.
Returning a promise requires an await where omitting it changes catch or finally behavior, without requiring awaits on every return.
Classic cyclomatic complexity has a ceiling of 14 across production code, tooling, and tests.
This is a maintenance limit, not proof of correctness or a scientifically distinct threshold.

The linter owns dependency-cycle detection instead of a second dependency-analysis tool.
Existing module-boundary checks retain the rules they already enforce rather than duplicate them in imported plugins.
Custom rules have beside-tests that accept valid code and reject deliberate violations.
The cycle proof continues to demonstrate that a real module cycle fails through the selected checker.
Environment access uses one schema-validated owner rather than raw reads throughout the application and tests.

There is no separate lint-version drift record.
The exact pin, lock data, and PR review supply the upgrade decision without another value that must agree with them.
Unselected style restrictions and application-specific rules do not enter the policy merely because another repository uses them.

## Consequences

- Adoption includes the cost of fixing existing violations before the policy can pass.
- Type-aware lint adds a toolchain dependency and test-specific settings that upgrades must verify.
- Replacing a checker requires preserving deliberate-break proof rather than treating a new command's success as evidence.
- Review must assess upgrades without a separate drift gate.
- Complexity findings require simpler branching or extraction of a clear operation, not arbitrary wrappers or a different counting variant.

## Alternatives considered

- Adopting every upstream rule was rejected because some rules duplicate stronger checks, misclassify valid CLI patterns, or apply to another domain.
- Keeping both cycle tools was rejected because two owners would enforce the same policy with different diagnostics.
- A separate reviewed-version record and drift check were rejected because they duplicate the dependency pin and lock.
- Deferring fixes behind a baseline was rejected because a newly selected error policy must apply to the code it checks.

Related: ADR-0004, validated environment and path ownership; ADR-0016, local mutation testing complements enforced checks without becoming a gate; ADR-0019, selected errors-as-values contract and unthrown lint rules.
