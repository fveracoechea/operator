# Mutation survivor cleanup, issue 260

This record covers the changed-lines mutation cleanup under ADR-0016 with the tool from #238.

## Merge base and commands

- Merge base with `main`: `fc21724c3ce457d20b00f9a168e2a8d59c60b8f6`.
- Command per unit: `bun run mutate --since fc21724c3ce457d20b00f9a168e2a8d59c60b8f6 <unit>`.
- The selection covers 157 units in `cli.ts`, `lib/`, `modules/`, `scripts/`, and `tools/oxlint/`. Four of them are new files split out during this work.
- Each unit has its own run log, run at different times.
- By the person's decision, no final full rerun over all units was done. Some units changed after their last clean run, for example by formatting, by more tests, or by a moved function.

## Result

| State | Units |
| --- | --- |
| Clean in its last run: exit 0, no survivors, untested targets, or incomplete results | 155 |
| 1 incomplete result, no survivors, not rerun by the person's decision | 2 |

Units with 1 incomplete result:

- `scripts/mutate.ts`: 0 survivors, 0 untested, 1 incomplete (Timeout), 164 killed, 9 ignored. The timed-out mutant drops survived results from the incremental file. Its killing test was last in a slow file. That test now runs first, and the mutant applied by hand fails in 10 s.
- `modules/device-state/backups.ts`: 1 incomplete (Timeout at line 121 under load), 89 killed. Only its test changed.

The other 155 units were clean in their last run.

## Tool and layout changes

- `scripts/mutate.ts` passes `--bail` to the per-mutant test command, so the first failed test kills the mutant.
- `scripts/mutate.ts` runs the checkout's unmutated `scripts/test-watchdog.ts` by absolute path for each mutant, so a mutant in the runner never judges itself.
- `scripts/mutate.ts` keeps incremental results in `.mutation-incremental/`, keyed by the mutated ranges, the beside-tests, and the runner. A rerun of `modules/pull-requests/cleanup.ts` with no change took 11.6 s, against 875 s for the first run. Remove that folder before the final full run, because a stored result does not see a change in an imported file.
- `scripts/mutate.ts` sets `timeoutFactor` 1.5 and `timeoutMS` 2000.
- `scripts/test-watchdog.ts` gave its `ps` parse to `scripts/process-tree.ts`, which has a direct beside-test for padded columns and blank lines. The lsof list has no 80-line limit now.
- `scripts/test-watchdog.test.ts` and `scripts/mutate.test.ts` failed on a busy machine. They now have longer time limits, a stall test that does not depend on start time, and real fixture paths (macOS `/var` is a link to `/private/var`).
- `scripts/mutate.ts` sets `disableTypeChecks` for `modules`, `lib`, `scripts`, and `tools`. The release build runs strict `tsc` over the instrumented sandbox files, which failed before. `cli.ts` keeps its declaration comments and file mode.
- Test helpers named `fake-*.ts`, `fixture-command.ts`, and `test-schemas.ts` are renamed to `*-fixture.ts`, so the mutation policy excludes them as fixtures.
- `modules/operator-cli/run.ts` gave its project and settings handlers to `projects.ts` and `settings.ts`, its startup checks to `startup.ts`, and its help, version, and invalid-argument output to `usage.ts`, each with a direct beside-test. `run.ts` keeps only the handler order.
- Each unit that had no direct beside-test now has one. This includes `cli.ts`, the module interfaces of pull-requests, review-requests, worker-dispatch, worktree-preparation, herdr, report-assignments, and global-launcher, and the untested scripts and lint rules.
- Production edits are simplifications that keep behavior: removed branches that no input reaches, finite loops in place of open loops, joins in place of undefined checks, and shared helpers.

## Product defects found

- `tools/oxlint/anti-slop/validator-subject.ts`: `isGlobalType` treated the built-in `Object` as a specific validator target, so `value is Object` passed the rule. Fixed.

No other group found a behavior that was wrong for a user.

## Accepted mutation suppressions

Each suppression states its reason in its own `// Stryker disable next-line <Mutator>: equivalent: ...` or `no rule: ...` comment.
`git grep -n "Stryker disable"` lists them.
