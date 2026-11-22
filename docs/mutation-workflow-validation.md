# Local mutation workflow validation

## Candidate and scope

The comparison baseline is reconciled main `f238eaf`, not the obsolete pre-reconciliation branch base.
The integration input is `ff939eccc61c27bb70683a1d4de8f7685bd6ca1e`.
This work reuses the landed lint fixtures, explicit parked-supervisor identity and measured recovery timeout.
It does not change production delivery authorization, CI, releases, or real legacy state.

The original cheap plan selected 19 production units and 88 test files, with zero skipped units.
Final verification regenerates the complete selection and opportunity census after review corrections.
The command owner remains selected at `run.ts:32` and `run.ts:183`, with 70 beside-test files.
These import/call replacement ranges have zero generated mutation opportunities.
The owner still requires its public-command regression coverage.
The worker owner includes its direct and protocol beside-tests.
The remaining production owners are:

- `src/modules/operator-cli/worktree-observation.ts`
- `tools/mutate.ts`
- `tools/mutation-admission.ts`
- `tools/mutation-budget.ts`
- `tools/mutation-campaign.ts`
- `tools/mutation-claim.ts`
- `tools/mutation-dependencies.ts`
- `tools/mutation-engine-progress.ts`
- `tools/mutation-evidence.ts`
- `tools/mutation-plan.ts`
- `tools/mutation-preflight.ts`
- `tools/mutation-resume.ts`
- `tools/mutation-reuse.ts`
- `tools/mutation-run.ts`
- `tools/mutation-selection.ts`
- `tools/mutation-snapshot.ts`
- `tools/mutation-toolchain.ts`
- `tools/mutation-worker.ts`

## Measured costs and evidence

The original runner command baseline took 31.75 seconds.
After its decision extraction, the retained command baseline took 70.51 seconds under overlapping load.
The new deterministic decision tests initially took 50 milliseconds.
These are separate observations, not a command-speedup ratio.

Before the Git protocol extraction, 69 command files did not finish their baseline within 260 seconds.
Its diagnostic mutation run also expired before producing verdicts.
The extracted protocol's 18 direct tests took 120 milliseconds through the repository test script.
Its final fresh campaign killed 46 mutations in 10.56 seconds.
The command-owner campaign's 15-minute expiration was incomplete, not a passing baseline.
The reconciled owner now selects 70 files because main added commit-delivery coverage.
No test was renamed or removed to reduce the selection.

The repaired budget fixture deliberately spends over three seconds completing its first real engine unit.
It then advances a controlled clock only after the held test creates its receipt.
This removes the old assumption that startup and completed evidence fit inside 2.5 wall-clock seconds.
The original fixture fails deterministically with that slower first unit.
The repaired test retains passed/interrupted/unrun evidence and proves owned work stops before fallback cleanup.
It also exposed duplicate cancellation before Bun published `exitCode`; cancellation is now idempotent.

The composed disposable Git candidate plans without effects, fails its baseline, retains completed work, repairs and resumes.
An edited production input invalidates the old success and executes a failing baseline.
Restoring the exact candidate qualifies again without rewriting historical evidence.
Existing tests additionally retain live progress, budget CLI, uncertain dependencies, interrupted claims, real Git/SQLite and installed workflows.

Before final campaigns, 228 focused tests passed with 1,039 assertions in 75.04 seconds.
Static quality passed, including all 17 deliberate module-boundary rejection proofs.

## Reproduction and qualification

The detailed execution ledger is `/tmp/opencode/446-453-evidence.md`.
It records admitted identities, terminal statuses, reuse decisions, exact command lines and bounded campaign logs.
An interrupted command is never a passing qualification.
The unchanged outer runner's original three hashes are checked before and after scoped verification.
Normal dependency-aware caches remain intact.

```sh
bun run mutate --plan --json --since f238eaf
bun run quality:static
timeout --signal=INT --kill-after=30s 40m bun run quality
timeout --signal=INT --kill-after=30s 8m bun run test ./src/modules/operator-release/installed-workflows.test.ts
```

Runner mutations use `/tmp/opencode/447-outer/tools/mutate.ts`, never the runner under test as its own judge.
The full target inventory above remains authoritative when campaigns are split by cost.
Budget expiry requires a measured bottleneck report and a separately authorized invocation, not a silent extension.
Independent review follows the fixed implementation commit; findings and dispositions belong in the final delivery ledger.
This document does not claim a final campaign passed before its terminal evidence exists.

## Review corrections

Review compared `930706898f3accd48d41b85f15b58a5b25b7aed3` with `f238eaf`.
The correction ledger is `/tmp/opencode/446-review-corrections-evidence.md`.

- **Stale external snapshots.** A public-command regression reproduced ordinary Bun test failure followed by stale passing mutation reuse.
  Dependency identity now includes each visited source file's external Bun snapshot.
  The regression requires the changed snapshot unit to execute and fail while the unrelated unit still reuses its pass.
- **Mutable installed application dependencies.** An actual package import reproduced changed bytes through the admitted live link.
  Admission now copies the complete installed tree and includes its bytes, file modes and executable links in current-input identity.
  Complete copying covers undeclared imports, nested packages and literal runtime reads without pretending a manifest proves all dependencies.
  Admission outside the checkout prevents fallback to live ancestor dependencies.
  Re-review reproduced a remaining defect in directory aliases on the first correction candidate.
  Flattening a store-backed package selected a hoisted dependency instead of its private dependency.
  Retargeting the alias with identical package bytes also left the old fingerprint unchanged.
  Internal file and directory links now retain canonical targets inside the private installed layout.
  Link targets, installed-root identity and directory modes participate in the fingerprint.
  External package aliases and cyclic directory links refuse admission instead of changing package resolution.
  A held multi-unit case additionally retargets only a store alias and checks frozen execution plus current-input refusal.
  Held multi-unit regressions retain admitted package imports after source or installed-only edits and refuse current qualification.
  A 1.0 GiB installed-tree probe took 1.55 seconds to fingerprint and 4.37 seconds to copy and verify.
- **Unchecked IPC.** Controlled real workers reproduced malformed and foreign-run terminal messages.
  The command now validates the complete event schema and owned claim token before replacing evidence.
  Invalid messages stop owned execution and preserve the last valid mutant evidence as incomplete.
  Direct schema coverage includes required nested fields and optional preflight, progress and admission data.
- **Duplicated initial evidence.** Execution, preflight and admission now use one initial-state constructor.
  Execution and preflight retain their separate scheduling and qualification rules.

No required target, test assertion, existing effect-level regression, or production authorization was removed.
Simple command fixtures provision empty application installs instead of unrelated compiler and SDK packages.
Source readiness and repository-owned tooling fixtures retain their actual installed dependencies.
The existing cohesive changeset remains the only changeset for this work.
The first correction's focused check passed 240 tests and 1,159 assertions across 18 files in 96.07 seconds.
Re-review kept the installed-input finding open; those checks did not establish complete qualification.
Its obsolete full-quality run stopped with exit 130 and cannot qualify the corrected candidate.
The captured nested failures belonged to intentional broken-guard tests, not unexpected outer-suite failures.
The directory-topology correction then passed all 243 focused tests and 1,185 assertions in 105.41 seconds.
Static quality passed again, including all 17 deliberate boundary-rejection proofs.
Replacement broad checks wait for independent review confirmation of the amended candidate.
Full corrected-candidate quality, immutable-outer mutation and installed smoke remain pending until their terminal ledger evidence exists.

## Final review corrections

Worker protocol tests now distinguish bounded failure from test-process leakage.
Five exact broken variants assertion-failed within 2.43 seconds.
The unchanged-input command diagnostic completed all 61 mutants, with 53 reused and eight newly killed.
No survivors or incomplete results remained in that diagnostic.

Bun's parallel-file bail lets another active file finish after an assertion fails.
Fast campaign protocol cases therefore precede the retained effect cases in the same owner file.
All 23 original effect cases remain.
One private worker-path expectation follows the removed subdirectory; its isolation assertions remain.
Three retained public-command path expectations follow the same layout change.
Their original effect cases passed together in 27.68 seconds.
An actual instrumented campaign mutant then assertion-failed in 0.502 seconds instead of timing out.
Cancellation tests observe descendant liveness before fallback cleanup.

The public command initially rejected this checkout's tracked README alias.
Admission preserves safe internal regular-file aliases as links to privately copied targets.
Link topology and target bytes participate in identity.
Unsupported external, directory, cyclic and dangling source links still refuse admission.
The real-checkout command killed 46 mutants in 12.734 seconds.
The source-link correction's fresh immutable-outer check killed all 190 selected mutants in 58.563 seconds.
Both checks retained unchanged inputs.

Machine mode emits versioned refusal frames for busy worktrees, changed inputs and exhausted budgets.
Refusal frames claim no admitted run or ownership.
Worker IPC still rejects these frames.
The admission mismatch error exposes the stable `inputs-changed` cause without changing its human message.
Its changed-line check killed all three mutants in 3.422 seconds.
The consumer must handle that cause before execution and emit only one refusal.

The fallback initial event's `run-started` literal has a narrow equivalent-mutant annotation.
Only the distinction from `run-completed` affects decisions, and completion overwrites this tag before publication.
The redundant private `snapshot` subdirectory was removed instead of suppressed.

These are diagnostic and correction receipts, not whole-candidate qualification.
Final quality, complete scoped mutation and disposable installed smoke must pass on the same frozen candidate.
The final issue resolution records the exact candidate, tree, commands, counts and stable-input receipts.
