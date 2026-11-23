# Mutation testing

## Select targets

Run from the repository root after installing the locked dependencies.

```sh
bun run mutate src/lib/sha256.ts
bun run mutate src/lib/sha256.test.ts
bun run mutate --since HEAD
bun run mutate --since origin/main src/lib/sha256.ts
bun run mutate --plan --since origin/main
bun run mutate --preflight --budget 60 src/lib/sha256.ts
bun run mutate --json --budget 300 --since origin/main
bun run mutate --resume <run-id> --budget 300
```

Explicit paths select whole units.
Package source under `packages/*/src/` uses the same discovery and beside-test rules as application and tooling source.
Build output under `dist/` is generated content, not a separate mutation owner.
A beside-test path selects its matching unit.
With `--since`, the tool checks changed current lines relative to the named commit, including staged and unstaged changes.
New untracked eligible units count as wholly changed.
Optional paths limit that selection to matching units.
Deleted lines and changes only to tests do not select old production lines.
For final delivery, pass the recorded comparison commit with `main` explicitly.
No target is a usage error, never a whole-repository request.

Only a unit's same-folder `stem.test.ts` and `stem.<scenario>.test.ts` run for that unit.
Private logic needs its own direct beside-test.
Tests, fixture files and folders, declarations, and generated content are not mutation targets.
A no-logic file can opt out with this exact first line:

```ts
// Stryker disable all: no logic
```

## Plan and bound execution

`--plan` selects without launching tests, acquiring a claim, or changing run evidence.
It reports ranges, selected test files, and repeated test-file executions per sweep.
Test-case counts remain unknown.
Inspect large selections before starting expensive work.

For a correction proof, use the current selector rather than inferring ownership from imports.

```sh
bun run mutate --plan --json tools/mutation-campaign.ts
bun run mutate --plan --json --proof /absolute/path/proof.json tools/mutation-campaign.ts
```

The proof JSON contains `owner`, `tests`, and `evidence` (`assertion-failure` or `engine-verdict`).
Copy the owner's exact ordered `tests` list from the current plan.
The check returns exit 1 for an unselected owner, an empty owned list, or a different test list.
It reports `insufficient-owner-tests` in human and machine output.
A matching list reports `matching-owner-tests`, not mutation qualification.
The evidence kind is the author's claim; this check does not authenticate an engine verdict or assess assertion adequacy.
Reviewers inspect the command, outcome, and assertions separately.
Retain effect-level CLI tests alongside direct-owner tests.

`--preflight` explicitly measures the initial engine test run against admitted inputs.
It reports completed-unit reuse eligibility before baseline execution, but always measures the baseline.
It returns incomplete exit 3, not mutation qualification.
Mutation counts remain unknown unless established by the engine.
Estimates state their sequential, no-reuse, full-suite assumptions and excluded startup overhead.

`--budget` bounds owned execution in positive seconds, including admission.
Expiry stops owned work, preserves completed verdicts, and records interrupted and unrun work separately.
It returns exit 3 with `budget-exhausted`.
Cleanup still stops owned descendants and releases resources.
Continuing requires another explicit invocation.

Normal execution reports progress on stderr and saves `.mutation-runs/<run-id>.json`.
`--json` emits versioned newline-delimited events on stdout.
Before campaign handoff, budget expiry emits one refusal frame instead of a run event.
A busy claim, changed selection, or snapshot verification drift also emits a refusal before worker execution:
`{"version":1,"type":"refusal","reason":"worktree-busy","code":3}`.
The stable reasons are `worktree-busy`, `inputs-changed`, and `budget-exhausted`.
Refusals carry no run ID, admitted identity, sequence, or ownership claim, and are not worker IPC events.
They preserve exit 3 and the human stderr diagnostic without overwriting another owner's evidence.
After admission, the existing run events and terminal admission reasons remain unchanged.
Human and machine output use the same state.
Unknown totals are distinct from zero.
The default scheduler stops before the next unit after a failing or incomplete unit.
`--keep-going` deliberately continues diagnostics but retains the failing outcome.
Fail-fast occurs after a unit verdict, not at the first surviving mutant.
Within each mutant, the first failed test still stops its test command.

## Admission, reuse and resume

One campaign owns each worktree.
Independent worktrees have separate claims.
Execution uses one admitted snapshot of actual tracked and relevant untracked inputs.
Internal source file aliases retain private links to already admitted regular files.
Their raw and canonical targets, target bytes and modes participate in the identity.
External, dangling, cyclic and directory source aliases refuse admission.
Source paths through aliased ancestors and link paths with cancelled components also refuse admission.
The snapshot copies the installed `node_modules` tree, including undeclared packages and nested dependencies.
Installed bytes, executable modes and binary links participate in admission and current-input identity.
Real package directories become private copies, while internal file and directory links retain their installed resolution.
Raw link targets, canonical private targets and the installed-root identity participate in the fingerprint.
Cyclic directory links and links outside the installed tree refuse admission.
An installed-root alias must resolve to a complete `node_modules` root.
The snapshot lives outside the checkout so missing packages cannot resolve through live parent directories.
An empty installed directory prevents automatic installation of unadmitted packages.
Final qualification checks that the current inputs still match.
Historical passing results cannot authorize an edited candidate.
`--recover-claim` preserves evidence and recovers only a provably dead owner and process group.
Live, unreadable or uncertain claims refuse recovery.
Cancellation signals only owned processes.

Completed-unit receipts include production and test dependencies, external Bun snapshots, literal fixtures, configuration, runner bytes, and installed toolchain identities.
Changing a known import or fixture invalidates affected units while unaffected units can reuse completed evidence.
Dynamic or unresolved imports, external packages, custom test commands, preloads, and unproved runtime effects conservatively execute fresh.
This repository's watchdog command is such a conservative case.
Before execution, each tested unit emits a `reuse-decision` event and the same human diagnostic.
The unit's `reuse` evidence separates `eligible` from the cache `lookup`.
Ineligible identities report `unsupported-test-command`, `uncertain-inputs`, or `unreadable-inputs`; their lookup is `not-checked`.
Eligible identities report `hit`, `miss`, `inputs-changed`, or `unusable`.
`inputs-changed` compares a known prior resume identity or a mismatched receipt.
Without a prior identity, absent current evidence is a `miss`, not proof that inputs never changed.
Selection-only `--plan` remains cheap and does not inspect dependencies or the cache.
Eligible partial engine reports can reuse completed mutant verdicts without treating unfinished mutants as passed.
Malformed or truncated completed receipts force fresh execution.
Worker IPC events require the complete runtime schema and the owned run identity.
Malformed or foreign-run events preserve the last valid evidence and make execution incomplete.
Ignored results remain ignored, not killed.
Do not clear the final cache as a substitute for validating this dependency contract.

`--resume <run-id>` reselects the recorded units against current inputs and checks their reuse identities.
It executes unfinished or invalidated work and retains eligible completed work.
Preflight evidence cannot resume mutation qualification.
Resume does not trust historical changed-line ranges or overwrite the old run.

## Exact-candidate delivery

Mutation testing is local, not a CI gate.
A PR is not required for this local workflow.

1. Implement and run focused tests.
2. Obtain independent review and fix its findings.
3. Record the comparison commit, candidate identity, complete production target inventory, and explicit budgets.
4. Run full quality, scoped mutation verification, and applicable disposable installed-command smoke on final inputs.
5. Retain commands, terminal outcomes, costs, ignored results, and reuse decisions with the delivery evidence.

Failed, interrupted, stale, uncertain and unrun work never authorize qualification.
An expired budget is a blocker, not permission to extend a campaign silently.
Report measured bottlenecks before proposing another bounded invocation.
Implementation and review use the installed `implement/validation.md` checkpoint for cumulative spending and human renewal.
Carry its absolute task-ledger path across agents, worktrees, and wrappers.
After failed or exhausted broad validation, report cumulative cost, completed evidence, unresolved work, and the proposed next action.
Wait for the person's decision before another broad campaign.
The per-invocation `--budget` does not grant that decision or reset the task's spending history.
Keep zero-opportunity changed owners in the inventory and verify their public regressions.
Use an unchanged outer runner and private sandboxes when mutating runner logic.
Retain real Git, SQLite, public-command and installed-command tests when extracting fast private seams.
Existing production delivery guards still apply to their own workflows.

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
Record each accepted suppression in the delivery evidence, whether or not delivery uses a PR.
Broad disable comments and empty or unknown reasons are usage errors.

Exit 0 means no reported survivors, untested units, or incomplete results.
Exit 1 means a usage or suppression error.
Survivors or untested units give exit 2.
Exit 3 means incomplete execution, including a failed baseline, timeout, runtime error, busy worktree, changed inputs, or exhausted budget.
Fix the execution problem and rerun before claiming a clean result.
