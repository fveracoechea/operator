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
Reusable functions in `lib/` follow the same rule.
Do not export private logic through `main.ts` only to test it.

## Assert the contract

Use known inputs and independently worked expected results.
Assert returned data, state changes, exit codes, and external effects that the caller can observe.
A refusal test proves that the forbidden write or external action did not occur.
An assertion that a result is defined or has a type rarely proves its behavior.

For Operator workflows, use the public CLI with real Git and SQLite and isolated device roots.
Use controlled executables or HTTP servers for external tools.
Keep pure decisions in direct deterministic tests.
Use the repository's test script so each file has an isolated global.
Use scoped spies at public module interfaces when needed and restore them after each test.

Run the selected test, then use the mutation topic to check whether its assertions distinguish changed behavior.
Confirm a guard by breaking it and observing a failing test.
Fix all observed test failures and flakes before completing the ticket.
