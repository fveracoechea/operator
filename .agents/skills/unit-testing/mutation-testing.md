# Mutation testing

## Select targets

Run from the repository root after installing the locked dependencies.

```sh
bun run mutate lib/sha256.ts
bun run mutate lib/sha256.test.ts
bun run mutate --since HEAD
bun run mutate --since origin/main lib/sha256.ts
```

Explicit paths select whole units.
A beside-test path selects its matching unit.
With `--since`, the tool checks changed current lines relative to the named commit, including staged and unstaged changes.
New untracked eligible units count as wholly changed.
Optional paths limit that selection to matching units.
Deleted lines and changes only to tests do not select old production lines.
For the final delivery cleanup, pass the merge-base commit with `main` explicitly.
No target is a usage error, never a whole-repository request.

Only a unit's same-folder `stem.test.ts` and `stem.<scenario>.test.ts` run for that unit.
Private logic needs its own direct beside-test.
Tests, fixture files and folders, declarations, and generated content are not mutation targets.
A no-logic file can opt out with this exact first line:

```ts
// Stryker disable all: no logic
```

Stryker's command runner starts a fresh Bun process for each mutant, with the sandbox as the working folder.
It runs the checkout's unchanged `scripts/test-watchdog.ts`, so a mutant in the test runner never judges itself.
A project without that runner uses its `test` script.
The first failed test kills a mutant, and a hanging mutant stops soon after the time of a clean run.
The tool keeps killed and survived results in the ignored `.mutation-incremental/` folder.
A rerun reuses a result when its code, the unit's beside-tests, and the runner did not change.
A timeout or other incomplete result always runs again.
A stored result does not see a change in an imported file.
Remove `.mutation-incremental/` before the final full run.
It mutates disposable copies and removes them after the run.
It never copies `.operator` state or host skill links into those copies.
Mutation testing is local, not a consumer command, quality gate, or CI job.

## Survivors

Read each `file:line: survived: Mutator` result.
Find an input that makes the original and replacement give different promised results.
Add that case to the unit's beside-test, assert the result, then run the same mutation target again.
Do not broaden the run to interface tests that hide missing direct tests.
For `untested`, add a direct beside-test before assessing assertions.

First try to simplify code that produces a mutant no test can kill.
If simplification cannot remove it, suppress only the named mutator on the next line.
The reason must start with `equivalent:` or `no rule:` and include an explanation.

```ts
// Stryker disable next-line StringLiteral: no rule: the diagnostic wording is not a promised result
```

Use `equivalent:` only when no input distinguishes the mutant.
Use `no rule:` only when Operator promises no behavior for that difference.
Record each accepted suppression in the delivery PR.
Broad disable comments and empty or unknown reasons are usage errors.

Exit 0 means no reported survivors, untested units, or incomplete results.
Exit 1 means a usage or suppression error.
Survivors or untested units give exit 2.
Exit 3 means incomplete execution, including a failed initial test run, timeout, or runtime error.
Fix the execution problem and rerun before claiming a clean result.
