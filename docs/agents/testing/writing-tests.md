# Writing tests

## Name the unit

Put `stem.test.ts` or `stem.scenario.test.ts` in the same folder as `stem.ts`.
A scenario can have a longer name, such as `stem.refusal.test.ts`.
If both `stem.ts` and `stem.refusal.ts` exist, `stem.refusal.test.ts` covers the latter.
The longest existing unit stem wins.
A test in another folder does not cover the unit for mutation testing.

Module tests call the named interface object and assert caller-observed results.
Only `main.test.ts` and `main.<scenario>.test.ts` cover `main.ts`.
Private files with logic also need direct beside-tests that import the private file.
Reusable functions in `src/lib/` follow the same rule.
Do not export private logic through `main.ts` only to test it.

## Assert the contract

Use known inputs and independently worked expected results.
Assert returned data, state changes, exit codes, and external effects that the caller can observe.
A refusal test proves that the forbidden write or external action did not occur.
An assertion that a result is defined or has a type rarely proves its behavior.

For Operator workflows, use the public CLI with real Git and SQLite and isolated device roots.
Use controlled executables or HTTP servers for external tools.
Keep pure decisions in direct deterministic tests.
Extract an actual private decision or protocol when its command's beside-tests provision unrelated workflows for every mutant.
Keep the command's existing test ownership and real effect coverage.
Measure selected files and baseline cost before and after extraction; fewer targets alone do not establish improvement.
For budgets, use controlled clocks or bounded executables.
Synchronize interruption with an observable receipt instead of assuming engine startup finishes within a short wall-clock window.
Use the repository's test script so each file has an isolated global.
Use scoped spies at public module interfaces when needed and restore them after each test.

Run the selected test, then use the mutation topic to check whether its assertions distinguish changed behavior.
Confirm a guard by breaking it and observing a failing test.
For mutation corrections, record the production owner and its current selector-owned test list.
Check structured proofs through the mutation topic's cheap plan before treating them as direct-owner evidence.
Fix all observed test failures and flakes before completing the ticket.
For final local qualification, follow the exact-candidate sequence in [mutation testing](mutation-testing.md).
