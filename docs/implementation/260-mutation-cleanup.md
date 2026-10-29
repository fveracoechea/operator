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

Clean units:

- `cli.ts`
- `lib/coded-error.ts`
- `lib/real-path.ts`
- `lib/sha256.ts`
- `lib/slug.ts`
- `modules/agent-hosts/catalog.ts`
- `modules/agent-hosts/main.ts`
- `modules/device-settings/change.ts`
- `modules/device-settings/edits.ts`
- `modules/device-settings/main.ts`
- `modules/device-settings/schema.ts`
- `modules/device-settings/selection.ts`
- `modules/device-settings/state-machine.ts`
- `modules/device-settings/storage.ts`
- `modules/device-settings/validation.ts`
- `modules/device-state/cleanups.ts`
- `modules/device-state/compatibility.ts`
- `modules/device-state/creation.ts`
- `modules/device-state/database.ts`
- `modules/device-state/failures.ts`
- `modules/device-state/launches.ts`
- `modules/device-state/main.ts`
- `modules/device-state/migration-policy.ts`
- `modules/device-state/project-files.ts`
- `modules/device-state/projects.ts`
- `modules/device-state/pull-requests.ts`
- `modules/device-state/reports.ts`
- `modules/device-state/review-requests.ts`
- `modules/device-state/schema.ts`
- `modules/device-state/slack.ts`
- `modules/device-state/sources.ts`
- `modules/environment/main.ts`
- `modules/github-api/call.ts`
- `modules/global-launcher/main.ts`
- `modules/global-launcher/plan.ts`
- `modules/herdr/main.ts`
- `modules/operator-cli/dispatch.ts`
- `modules/operator-cli/launcher.ts`
- `modules/operator-cli/output.ts`
- `modules/operator-cli/profiles.ts`
- `modules/operator-cli/pull-requests.ts`
- `modules/operator-cli/readiness.ts`
- `modules/operator-cli/reports.ts`
- `modules/operator-cli/reviews.ts`
- `modules/operator-cli/run.ts`: clean only with two local tool settings that are not committed: `dryRunTimeoutMinutes: 60`, because the dry run of its 37 CLI test files takes more than 5 minutes, and `disableTypeChecks` without test files, because its readiness guard test needs type checks.
- `modules/operator-cli/skills.ts`
- `modules/operator-cli/startup.ts`
- `modules/operator-cli/sources.ts`
- `modules/operator-cli/usage.ts`
- `modules/operator-home/main.ts`
- `modules/operator-release/build.ts`
- `modules/operator-release/inventory.ts`
- `modules/operator-release/main.ts`
- `modules/operator-release/manifest.ts`
- `modules/operator-release/registry-install.ts`
- `modules/operator-release/specifiers.ts`
- `modules/owned-skills/content.ts`
- `modules/owned-skills/install.ts`
- `modules/owned-skills/main.ts`
- `modules/owned-skills/write-file.ts`
- `modules/projects/checkout.ts`
- `modules/projects/identity.ts`
- `modules/projects/main.ts`
- `modules/pull-requests/cleanup-machine.ts`
- `modules/pull-requests/cleanup.ts`
- `modules/pull-requests/github.ts`
- `modules/pull-requests/main.ts`
- `modules/pull-requests/merge-machine.ts`
- `modules/pull-requests/merge.ts`
- `modules/pull-requests/owner.ts`
- `modules/pull-requests/relay.ts`
- `modules/pull-requests/wait-machine.ts`
- `modules/readiness/main.ts`
- `modules/release-publish/delivery.ts`
- `modules/release-publish/github-release.ts`
- `modules/release-publish/jsr-registry.ts`
- `modules/release-publish/main.ts`
- `modules/release-publish/plan.ts`
- `modules/release-publish/tar.ts`
- `modules/report-assignments/content.ts`
- `modules/report-assignments/main.ts`
- `modules/review-requests/brief.ts`
- `modules/review-requests/draft.ts`
- `modules/review-requests/github.ts`
- `modules/review-requests/main.ts`
- `modules/review-requests/post.ts`
- `modules/review-requests/request.ts`
- `modules/review-requests/review-body.ts`
- `modules/review-requests/review-machine.ts`
- `modules/review-requests/reviewer.ts`
- `modules/review-requests/rounds.ts`
- `modules/review-requests/slack-effects.ts`
- `modules/review-requests/slack-input.ts`
- `modules/review-requests/slack.ts`
- `modules/review-requests/watch.ts`
- `modules/tool-invocation/main.ts`
- `modules/upstream-skills/catalog.ts`
- `modules/upstream-skills/main.ts`
- `modules/work-sources/assignment-machine.ts`
- `modules/work-sources/main.ts`
- `modules/work-sources/plan.ts`
- `modules/work-sources/report-machine.ts`
- `modules/work-sources/snapshot.ts`
- `modules/work-sources/source-machine.ts`
- `modules/worker-dispatch/brief.ts`
- `modules/worker-dispatch/hooks.ts`
- `modules/worker-dispatch/launch-checks.ts`
- `modules/worker-dispatch/main.ts`
- `modules/worker-dispatch/names.ts`
- `modules/worker-dispatch/observations.ts`
- `modules/worker-dispatch/plugin.ts`
- `modules/worker-dispatch/reviewer.ts`
- `modules/worker-dispatch/worktree-cleanup.ts`
- `modules/worktree-preparation/env-files.ts`
- `modules/worktree-preparation/generated.ts`
- `modules/worktree-preparation/main.ts`
- `scripts/check-module-shape.ts`
- `scripts/check-skill-shape.ts`
- `scripts/process-tree.ts`
- `scripts/test-watchdog.ts`
- `scripts/mutation-policy.ts`
- `scripts/mutation-selection.ts`
- `scripts/prove-module-boundaries.ts`
- `scripts/release.ts`
- `scripts/require-bun.ts`
- `scripts/test-bun.preload.ts`
- `tools/oxlint/anti-slop/array-method.ts`
- `tools/oxlint/anti-slop/function-parameters.ts`
- `tools/oxlint/anti-slop/index.ts`
- `tools/oxlint/anti-slop/no-chained-type-assertions.ts`
- `tools/oxlint/anti-slop/no-conditional-empty-object-spread.ts`
- `tools/oxlint/anti-slop/no-module-mocking.ts`
- `tools/oxlint/anti-slop/no-object-parameters.ts`
- `tools/oxlint/anti-slop/no-reduce-accumulator-copy.ts`
- `tools/oxlint/anti-slop/no-reflect-apply.ts`
- `tools/oxlint/anti-slop/no-reflect-get.ts`
- `tools/oxlint/anti-slop/no-runtime-typeof.ts`
- `tools/oxlint/anti-slop/no-unknown-parameters.ts`
- `tools/oxlint/anti-slop/no-unknown-returns.ts`
- `tools/oxlint/anti-slop/no-unknown-type-aliases.ts`
- `tools/oxlint/anti-slop/no-widen-then-assert.ts`
- `tools/oxlint/anti-slop/reflect-method.ts`
- `tools/oxlint/anti-slop/type-alias-resolution.ts`
- `tools/oxlint/anti-slop/validator-subject.ts`
- `tools/oxlint/check.ts`
- `tools/oxlint/custom-tests/index.ts`
- `tools/oxlint/custom-tests/no-fixture-assertion.ts`
- `tools/oxlint/operator/env-through-schema.ts`
- `tools/oxlint/operator/index.ts`
- `tools/oxlint/skill-topic.ts`
- `modules/device-state/sync.ts`
- `modules/operator-cli/projects.ts`
- `modules/operator-cli/settings.ts`
- `modules/report-assignments/failures.ts`
- `modules/work-sources/failures.ts`

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

Each entry names the file and line, the mutator, the behavior, and why no test can distinguish it (`equivalent:`) or why no contract specifies it (`no rule:`).
Line numbers are from the last run of each group and can move after formatting.
The PR #222 section "Accepted mutation suppressions" has the same list.

### core group suppressions

cli.ts: no no-logic marker. cli.ts has logic (main delegates, import.meta.main entry), so it got the new beside-test cli.test.ts. Its changed line is a comment, so it has 0 mutants.

#### from core-dsA.md
# core-dsA suppressions (device-settings change, main, schema, validation)

- `modules/device-settings/change.ts:129`, ConditionalExpression (`planned.reason !== undefined` in `applyLocked`). Behavior: return the edit refusal under the write lock. Equivalent: `apply` already ran `editConfig` with the same edits before the lock. The settings schema is strict and each edited field validates on its own, so an edit list fails on every valid config or on none. A changed config between the two reads cannot make the second check fail.
- `modules/device-settings/change.ts:132`, StringLiteral (`"absent"` in `applyLocked`). Behavior: the state of a missing receipt for the apply decision. Equivalent: no apply rule in `state-machine.ts` names `absent`. The rules that apply to `absent` have no `from` list, so an unknown state such as `""` gets the same decision.
- `modules/device-settings/change.ts:142`, OptionalChaining (`receipt?.state` in the repeat branch). Behavior: settle a pending receipt on a repeated apply. Equivalent: the `repeat` decision needs a receipt in `pending` or `complete`, so the receipt is never null there. The optional chain only narrows the type.
- `modules/device-settings/change.ts:179`, ConditionalExpression and StringLiteral (`written === "unconfirmed"`). Behavior: return `settings_write_unconfirmed` when the written bytes do not read back. Equivalent for every reachable input: `writeConfig` returns `unconfirmed` only when a local file read gives other bytes than the bytes it just synced to an exclusive temporary file or renamed into place. No test can make a local filesystem do that without fault injection inside `storage.ts`. The I/O failure path to the same result is tested.
- `modules/device-settings/change.ts:224`, ConditionalExpression (`receipt === null` in `recover`). Behavior: refuse recovery without a receipt. Equivalent: `complete` and `aborted` come only from a `pending` receipt, so the receipt is never null after the line above. The check only narrows the type. Its EqualityOperator mutant stays live and is killed.

#### from core-dsB.md
# core-dsB suppressions

- `modules/device-settings/selection.ts:30`, OptionalChaining on `config.profiles?.[request.profile]`. Behavior: read the named profile. Why: the ownership check before it returns `profile_missing` unless `config.profiles` owns the name, so `config.profiles` is never undefined here. No input distinguishes the mutant.
- `modules/device-settings/storage.ts:105`, ConditionalExpression, Regex, MethodExpression on the mode-bit check `!/[2367]/.test(info.mode.toString(8).slice(-3))`. Behavior: treat a destination with no write bit as externally managed, also for a privileged runner. Why: for an unprivileged test runner, `access(W_OK)` on the next lines refuses every mode with no write bit, so only a root runner (or an ACL that is not portable) can distinguish the mutant.
- `modules/device-settings/storage.ts:143`, ConditionalExpression on `(await Bun.file(paths.config).text()) === text` after the rename. Behavior: report `unconfirmed` when the renamed settings do not read back as the written text. Why: the temporary file read-back already confirmed the bytes, and only an outside writer between the rename and the read can change them. No deterministic test input distinguishes the mutant.
- `modules/device-settings/storage.ts:168`, ConditionalExpression on `error instanceof Error` in the editor schema catch. Behavior: skip a read-only editor schema destination. Why: `isReadOnlyFailure` refuses a value that is not an Error through `isCodedError` too, so the guard only narrows the type. No input distinguishes the mutant.

#### from core-hosts.md
# core-hosts suppressions

- `modules/operator-home/main.ts:25`, EqualityOperator (2 mutants ignored on this line, `<` and `>`) (`index <= parts.length` to `index < parts.length`). Behavior: the test-only root guard checks the fully resolved path once more after it follows the last path part. Why no test: the extra pass differs only when the last part is a link into an existing real Operator settings or state folder under the account home. A test must not create or inspect real Operator state, so the reason is `no rule`.

#### from core-proj.md
# Suppressions: core-proj (projects, owned-skills, upstream-skills, readiness)

Each line number is the line of the comment. The suppression covers the next line.

- `modules/projects/checkout.ts:38`, ConditionalExpression. Behavior: the legacy `.operator` probe ignores only ENOENT and rethrows other errors. Why: `isCodedError(cause)` to `true` is equivalent, because `lstat` rejects only with coded errors.
- `modules/projects/identity.ts:47`, ConditionalExpression. Behavior: an explicit `--repository` choice must be a valid identity that matches a remote. Why: `identity === null` to `false` is equivalent, because the list holds only strings, so `includes(null)` is false and the right side also refuses a null identity. A guard test patches this line, so the redundant check stays.
- `modules/owned-skills/content.ts:13`, ConditionalExpression. Behavior: `info` returns null only for ENOENT. Why: `isCodedError(cause)` to `true` is equivalent, because `lstat` rejects only with coded errors.
- `modules/owned-skills/content.ts:81`, ConditionalExpression. Behavior: only an exact ledger identity permits an update or removal. Why: `managed !== null` to `true` is equivalent, because `current` is not null on this line, so `same(current, null)` is false. A guard test patches this exact text, so the redundant check stays.
- `modules/owned-skills/content.ts:104`, BooleanLiteral. Behavior: an absent managed root takes the mode of its nearest existing ancestor. Why: the final `return false` is unreachable, because the walk includes the file system root, which always exists.
- `modules/readiness/main.ts:31`, `:46`, `:54`, ArrowFunction. Behavior: a settings, owned-skills, or upstream-skills defect stops readiness as a defect. Why: `.map` on a Defect never calls its function, so `() => blockers` to `() => undefined` is equivalent.
- `modules/readiness/main.ts:84`, ArrowFunction and ObjectLiteral. Behavior: a launcher defect stops readiness as a defect. Why: `.map` on a Defect never calls its function, so neither the function nor its object result can change the outcome.

### device-state suppressions

All paths are in `modules/device-state/`. Each line names the suppressed line, the mutator, the behavior, and why no test can distinguish the mutant or why Operator promises nothing about it.

#### Write reservation on transactions that write on every path

A write transaction starts with `BEGIN IMMEDIATE`. The `false` mutant starts with `BEGIN`. For the functions below, every path writes, so a deferred transaction takes the same writer reservation at its first write and gives the same result. Only a second process between `BEGIN` and the first write can observe the difference. Functions with a refusal or read-only path are not suppressed: their tests hold the reservation from a second connection and expect `state_busy`.

- `cleanups.ts:95`, BooleanLiteral. Behavior: `startCleanup` reserves the writer.
- `cleanups.ts:121`, BooleanLiteral. Behavior: `advanceCleanup` reserves the writer.
- `cleanups.ts:141`, BooleanLiteral. Behavior: `renewCleanup` reserves the writer.
- `launches.ts:215`, BooleanLiteral. Behavior: `renewLaunch` reserves the writer.
- `launches.ts:299`, BooleanLiteral. Behavior: `writeObservation` reserves the writer. The read before it found a match, so it always writes.
- `launches.ts:380`, BooleanLiteral. Behavior: `finishPreparation` reserves the writer.
- `launches.ts:394`, BooleanLiteral. Behavior: `renewPreparation` reserves the writer.
- `pull-requests.ts:283`, BooleanLiteral. Behavior: `renewPullRequestWait` reserves the writer.
- `pull-requests.ts:381`, BooleanLiteral. Behavior: `renewPullRequestRelay` reserves the writer.
- `review-requests.ts:320`, BooleanLiteral. Behavior: `renewReviewLease` reserves the writer.
- `slack.ts:58`, BooleanLiteral. Behavior: `startSlackWatch` reserves the writer.
- `compatibility.ts:14`, BooleanLiteral. Behavior: the startup upgrade reserves the writer before it reads the history. Why: one synchronous call gives no other connection a turn between `BEGIN` and the first write. Only concurrent starts observe it, which the CLI test "simultaneous public starts" covers.

#### Read-only connections

`query_only` refuses writes only. These connections only read, so the `false` mutant gives the same result.

- `compatibility.ts:40`, BooleanLiteral. Behavior: the startup reader opens with `query_only`.
- `main.ts:95`, BooleanLiteral. Behavior: `reading` opens each read operation with `query_only`.
- `main.ts:318`, BooleanLiteral. Behavior: `listProjects` opens with `query_only`.
- `backups.ts:70`, BooleanLiteral. Behavior: backup discovery opens each copy with `query_only`.
- `backups.ts:111`, BooleanLiteral. Behavior: the new backup copy is opened with `query_only` for its check.

#### Durable storage

A running process cannot observe whether bytes reached stable storage before a power loss. Operator promises durability but no observable result for it.

- `sync.ts:8`, BlockStatement. Behavior: the `try` block that calls `fsyncSync`.
- `sync.ts:10`, CallExpression. Behavior: `fsyncSync(fd)`. The `closeSync` in `finally` is not suppressed: a test counts open descriptors in `/dev/fd`.
- `backups.ts:109`, CallExpression. Behavior: synchronize the backup copy.
- `backups.ts:126`, CallExpression. Behavior: synchronize the backup receipt.
- `backups.ts:128`, CallExpression. Behavior: synchronize the backup folder.
- `backups.ts:130`, CallExpression. Behavior: synchronize the backups root.
- `creation.ts:51`, CallExpression. Behavior: synchronize the new database before its link.
- `creation.ts:64`, CallExpression. Behavior: synchronize the state root after the link.

#### Equivalent conditions

- `failures.ts:22`, ConditionalExpression. Behavior: an uncoded cause is a defect. Why: with the `false` mutant an uncoded cause reads `code` as `undefined` or a number, which matches no listed code, so it falls through to the same defect.
- `database.ts:81`, OptionalChaining. Behavior: compare the shipped migration time at each history index. Why: the hash comparison before it already refuses an index with no shipped migration. The text stays because the CLI guard "startup refuses conflicting-time" patches it.
- `compatibility.ts:17`, ConditionalExpression, EqualityOperator, BooleanLiteral. Behavior: the upgrade does nothing when another start already upgraded. Why: the reader returns first when the history matches, so only a concurrent upgrade between the two transactions reaches this line. Its `Ok(false)` only skips a prune that would remove nothing.
- `compatibility.ts:62`, ConditionalExpression. Behavior: prune backups only after this process upgraded. Why: the `true` mutant prunes after a concurrent upgrade, which already pruned to the newest three verified backups, so nothing changes. The `false` mutant is killed by the retention test but shares the mutator name.
- `backups.ts:37`, ObjectLiteral, StringLiteral. Behavior: the reason and detail of an invalid receipt or copy. Why: discovery skips every refused copy, so this value never reaches a caller.
- `backups.ts:47`, ArrayDeclaration. Behavior: a missing backups folder lists no backups. Why: the mutant lists one invented name. That name has no receipt, so its read fails and discovery skips it, which gives the same empty list.
- `backups.ts:78`, ArrowFunction, ArrayDeclaration. Behavior: an unexpected discovery failure stays a defect. Why: `map` never calls its function on a Defect, it only retypes it. The `"Defect"` tag check on the line is killed by a test. The text stays because the CLI guard "unexpected backup discovery defect" patches it.
- `backups.ts:80`, ConditionalExpression. Behavior: keep each verified copy. Why: an Err carries no `value`, so `result.tag === "Ok"` only narrows the type.
- `creation.ts:49`, ConditionalExpression. Behavior: return a refused registration of the new database. Why: a freshly migrated database has no project, removal, or checkout that can refuse the registration.
- `creation.ts:56`, ConditionalExpression, LogicalOperator, BlockStatement. Behavior: a link failure other than an existing name is an input failure. Why (no rule): the temporary file shares the folder with the database, so a test cannot make the link fail for any other reason. Both paths end as a qualified state failure.
- `project-files.ts:27`, ConditionalExpression. Behavior: a linked or non-folder segment refuses. Why: `lstat` never reports a link as a folder, so `!info.isDirectory()` already refuses a link and `info.isSymbolicLink()` changes no result. The text stays because the CLI guard "linked ancestor" patches it.
- `projects.ts:87`, ConditionalExpression. Behavior: find the record of this identity. Why: a checkout row of another identity returned above, so at most one row remains and it is this identity's.
- `cleanups.ts:73`, ConditionalExpression. Behavior: a cleanup with no owner is not running. Why: `ownerGone` already treats a null owner as gone. The text stays because the CLI guard "one process claims a cleanup" patches the next line.
- `reports.ts:88`, ConditionalExpression. Behavior: refuse a missing source or assignment. Why: the source id comes from a located source or from a launch whose foreign key names a source, so `source === undefined` is never true. The assignment half is killed by a test.
- `reports.ts:176`, ConditionalExpression. Behavior: finish a launch only when the change names one. Why: an absent launch id matches no launch row.
- `review-requests.ts:154`, ConditionalExpression. Behavior: update the request only when one exists. Why: with no request id the update matches no row.
- `launches.ts:52`, ConditionalExpression. Behavior: only ESRCH from `process.kill` means a gone owner. Why: `process.kill` fails only with a coded error, so `isCodedError` only narrows the type.
- `main.ts:299`, ConditionalExpression. Behavior: register in the existing database, or create it. Why: creation beside an existing database loses the hard-link race and registers in that database, which gives the same result.
- `sources.ts:244`, ConditionalExpression. Behavior: skip a launch with no worktree. Why: `existsSync(null)` is `false`, so the null check only narrows the type. The text stays because the CLI guard patches it. The `rows.some` part of the line is killed by a test.
- `sources.ts:323`, StringLiteral. Behavior: the refusal reason passed to the folder removal. Why: the `Err` below replaces this reason with `source_prune_failed`. The text stays because the CLI guard patches it.
- `slack.ts:134`, ConditionalExpression. Behavior: attach the thread to the latest request. Why: an `attached` outcome comes from an existing latest request, which this query finds again.

### dispatch suppressions

The `dispatch` group has no `// Stryker disable all: no logic` marker.

#### modules/herdr/main.ts

- `modules/herdr/main.ts:48`, ArrowFunction on the `fromThrowable` mapper of `JSON.parse`. Behavior: Herdr text that is not JSON parses to no value. Why: `JSON.parse` of a string throws only a `SyntaxError`, and the caller reads only the parsed value through `getOr(undefined)`, so a mapper that returns undefined for every cause gives the same result.
- `modules/herdr/main.ts:95`, StringLiteral on `stdout ?? ""` in `invoke`. Behavior: an absent answer parses as an empty answer. Why: `invoke` passes no absent error code, so `call` never answers null there. The fallback text is never read.

#### modules/worker-dispatch/observations.ts

- `modules/worker-dispatch/observations.ts:55` and `:113`, ConditionalExpression on `cause instanceof Error ? qualify(cause, defect) : defect(cause)` in `gitBranches` and `parentBase`. Behavior: a rejection that is not an Error is a defect. Why: `qualify` checks `isCodedError`, so it also passes a cause that is not an Error to `defect`. Both branches give the same result.
- `modules/worker-dispatch/observations.ts:58` and `:90`, ConditionalExpression on `result.status === "completed" && result.exitCode === 0`. Behavior: a Git invocation that did not complete gives no branch list or no head. Why: an invocation that did not complete has no `exitCode`, so `exitCode === 0` alone refuses it. The line also holds the exit-code conditions, which the tests kill.
- `modules/worker-dispatch/observations.ts:127`, ConditionalExpression on `workspace.checkout !== null`. Behavior: a Herdr workspace without a checkout is never the project workspace. Why: the real path of a null checkout is null, which never equals the controller checkout.

#### modules/worker-dispatch/main.ts

- `modules/worker-dispatch/main.ts:53`, ConditionalExpression on `source === undefined` after `WorkSources.show`. Behavior: an unknown source is not dispatchable. Why: `show` refuses an unknown source with `source_not_found`, so it never answers undefined here.
- `modules/worker-dispatch/main.ts:68`, ConditionalExpression on `planned === undefined || action === undefined`. Behavior: an assignment without a dispatch action is refused. Why: `next` gives a dispatch action only for a planned assignment, so `planned === undefined` never decides alone. The line also holds the `action === undefined` conditions, which the tests kill.
- `modules/worker-dispatch/main.ts:88`, ConditionalExpression and LogicalOperator on `open.length === 1 && parent !== undefined`. Behavior: a PR stacks only on its one open parent PR. Why: `next` gives no dispatch action while several parents are open, an open parent always has its PR, and with no open parent the PR lookup finds nothing.
- `modules/worker-dispatch/main.ts:113`, ArrayDeclaration on `Ok([])` for the tab labels of a missing project workspace. Behavior: no tab name is taken. Why: a taken name that no launch base can form, such as `Stryker was here`, changes no name choice.
- `modules/worker-dispatch/main.ts:122`, ConditionalExpression and LogicalOperator on `path === null || branch === null`. Behavior: a launch without a recorded worktree is not reused. Why: a launch with a worktree path always records its branch, and the real-path check on the next line refuses a missing path too.
- `modules/worker-dispatch/main.ts:223`, ConditionalExpression on the `writeBrief` mapper. Behavior and reason: the same as `observations.ts:55`.

#### modules/worker-dispatch/hooks.ts

- `modules/worker-dispatch/hooks.ts:31`, ConditionalExpression on `cause instanceof SyntaxError || cause instanceof z.ZodError`. Behavior: an event that does not parse is `herdr_event_invalid`. Why: `JSON.parse` and the zod parse throw only these two error types.

#### modules/worktree-preparation/main.ts

- `modules/worktree-preparation/main.ts:20`, ConditionalExpression on `result.status === "completed"` in `git()`. Behavior: a Git invocation that did not complete gives null. Why: such a result has no `exitCode`, so `exitCode === 0` is false and the result is null in both cases.
- `modules/worktree-preparation/main.ts:26`, ArrowFunction on `.catch(() => null)` in `commonDirectory`. Behavior: an unresolved common directory matches no project. Why: an undefined directory matches no project, the same as null. Both give `worktree_unregistered`.
- `modules/worktree-preparation/main.ts:86`, ConditionalExpression on `install.status !== "completed"`. Behavior: an install that did not complete fails the preparation. Why: such a result has no `exitCode`, so `exitCode !== 0` still fails it, with the same detail.

#### modules/worker-dispatch/worktree-cleanup.ts

- `modules/worker-dispatch/worktree-cleanup.ts:14`, ConditionalExpression on `result.status !== "completed"`. Behavior: a Git invocation that did not complete throws. Why: an invocation that did not complete has no exit code, so the exit check alone refuses it.

#### modules/worker-dispatch/reviewer.ts

- `modules/worker-dispatch/reviewer.ts:53`, ConditionalExpression on `result.status === "completed"` in `git()`. Behavior: a Git invocation that did not complete gives null. Why: such a result has no exit code, so the `exitCode === 0` check already gives null.
- `modules/worker-dispatch/reviewer.ts:98`, `:161`, `:236`, and `:331`, ConditionalExpression on `cause instanceof Error ? qualify(cause, defect) : defect(cause)`. Behavior and reason: the same as `observations.ts:55`. The comment also turns off the killable `false` mutant on those lines, which the ENOENT and ENOTDIR tests prove.
- `modules/worker-dispatch/reviewer.ts:110`, ArrayDeclaration on `Ok([])` for the tab labels of a missing project workspace. Behavior and reason: the same as `main.ts:113`.
- `modules/worker-dispatch/reviewer.ts:129`, StringLiteral on `?? ""` in the chosen branch. Behavior: the reviewer branch. Why: without a reused worktree, `chooseNames` gets a branch base and always returns a branch, so the empty fallback is never used.

All line numbers name the comment line. The suppressed mutant is on the next line.

### operator-cli suppressions

- `modules/operator-cli/sources.ts:24`, ConditionalExpression (`operation === undefined` to `false`).
  Behavior: `sourceArgs` refuses a group or command that is not a source operation.
  Why no test can distinguish it: an unknown operation gets no value flag (`valueFlags[undefined]` is undefined), so `sourceFlags` refuses every value flag. The operation is not `next` or `prune`, so a missing value also returns null. Every input gives null with and without the check. The check stays because TypeScript needs the narrowed operation for the `valueFlags` index.

No `// Stryker disable all: no logic` markers were added.

### pull-requests suppressions

Each entry names the line of the suppressed code (the line after its comment), the mutator, the behavior, and why no test can distinguish the mutant or why no contract specifies it.

#### modules/pull-requests/cleanup.ts

- `cleanup.ts:41`, ConditionalExpression on `result.status === "completed"` in `git`. Behavior: a Git call that did not complete counts as a failed command. Why: a result that did not complete has no exit code or output, so every caller (`?.exitCode === 0`, `?.stderr ?? ...`) reads the same value from it as from null. Tests prove the no-answer path for status, symbolic-ref, merge-base, update-ref, and worktree remove.
- `cleanup.ts:82`, `cleanup.ts:198`, `cleanup.ts:286`, StringLiteral on `mergedHead ?? ""`. Behavior: use the recorded merged head. Why: only a verified merge records a cleanup, and that write sets the merged head, so the fallback is never used.
- `cleanup.ts:150`, ConditionalExpression on `top !== null`. Behavior: the recorded path is its own Git top level. Why: `realPathOrNull(null)` is null and never equals the inspected real path.
- `cleanup.ts:153`, ConditionalExpression on `common !== null`. Why: the lines before proved the path is its own Git top level, so Git always names its common folder there.
- `cleanup.ts:155`, ConditionalExpression on `controller !== null`. Why: a null controller folder has a null real path, which never equals the real worktree common folder.
- `cleanup.ts:173`, ConditionalExpression on `launch.worktreePath === null`. Behavior: no recorded path has no real path. Why: `realPathOrNull(null)` is also null.
- `cleanup.ts:175`, ConditionalExpression on `real !== null`. Behavior: a missing path is not the recorded checkout. Why: Git cannot run in a null folder, so `recordedCheckout` returns false either way.
- `cleanup.ts:177`, ObjectLiteral, ArrayDeclaration, BooleanLiteral on the `empty` work facts. Behavior: a missing or foreign worktree is skipped or blocked as a mismatch. Why: `decideWorktree` decides those cases before it reads `changed`, `unknownIgnored`, or `landed`.
- `cleanup.ts:179`, ConditionalExpression and LogicalOperator on `real === null || !sameRepository`. Why: `sameRepository` is already false when `real` is null. The first operand stays for type narrowing.
- `cleanup.ts:235`, ConditionalExpression on `head !== null` in `landed`. Behavior: work without a head commit is not landed. Why: without a head commit `git merge-base --is-ancestor HEAD` fails too, so `landed` is false either way. The line is a guard string in `run.pr-merge-guards.test.ts`, so its text stays.
- `cleanup.ts:255`, ConditionalExpression on `workspace.checkout !== null`. Behavior: a Herdr workspace without a checkout is not the worktree. Why: `realPathOrNull(null)` is null and never equals the worktree real path.
- `cleanup.ts:279`, ConditionalExpression on `launch.worktreePath !== null` in `forgetWorktree`. Behavior: Git forgets the registration of the recorded path. Why: only a recorded path can be found absent (a null path is `not_recorded`), so the path is never null there.
- `cleanup.ts:299`, ConditionalExpression on `inspection.decision.action === "skip"`. Behavior: an absent worktree drops its registration. Why: only a skip decision has an `outcome`, so the outcome check alone selects the same decisions.
- `cleanup.ts:304`, ConditionalExpression and LogicalOperator on `inspection.real === null || inspection.decision.action !== "dispose"`, and `cleanup.ts:306`, ObjectLiteral and StringLiteral on its `cleanup_defect` failure. Behavior: a type guard before the removal. Why: every decision but dispose returned on the lines before, and inspection decides dispose only for a real path, so the guard never returns.
- `cleanup.ts:313`, ConditionalExpression on `inspection.head !== null`. Behavior: a branch without an inspected head is kept. Why: `git update-ref -d` with no head value fails, so the branch is kept either way.
- `cleanup.ts:365`, ArrowFunction on `recorded.map(() => outcomes)`. Behavior: a failed cleanup write is returned as the failure. Why: `map` on a failed or defect result never calls the function, so its value is never read.

#### modules/pull-requests/github.ts

- `github.ts:218`, StringLiteral on the defaults of `const [owner = "", name = ""] = repository.split("/")`. Behavior: fill the GraphQL owner and name fields. Why: `split` always returns a first element, so the owner default is never used. The test `a repository name without an owner part sends empty fields` proves the name default, which the same line holds.

#### modules/pull-requests/main.ts

- `main.ts:50`, ArrayDeclaration on `return []` for a missing source. Behavior: a missing source permits no stack parent. Why: an entry that is not a PR row has no branch, so it matches no PR base and the refusal lists `none` either way. The test `a missing source or plan row permits no stack parent` covers the branch.
- `main.ts:326`, ObjectLiteral and StringLiteral on the start value of `outcome`. Behavior: the wait reports the decision made inside the write. Why: a successful write always runs the decision, which replaces the start value before it is read, and a failed write never reads it.
- `main.ts:348`, EqualityOperator on `Date.now() >= deadline`. Behavior: a wait whose deadline passed records a timeout. Why (no rule): `>=` and `>` differ only when a poll ends in the same millisecond as the deadline, and Operator promises no result for that boundary.
- `main.ts:378`, ConditionalExpression on `pr === null`, and `main.ts:380`, ObjectLiteral and StringLiteral on its failure. Behavior: a wait without a PR record fails. Why: the start write always returns a change, so `recordPullRequestWait` returns the row or an Err (`pr_not_associated` from device state, which the test `a wait without a recorded PR records nothing` covers). The null branch is unreachable and only satisfies the type.

#### modules/pull-requests/merge.ts

- `merge.ts:19`, StringLiteral on `"cli.js"`. Behavior: a built release starts cleanup with `cli.js`, and a source install with `cli.ts`. Why (no rule for this test): only a built release has `cli.js` in the package root, and a beside-test cannot add one to the shared package root without changing what other tests and agents run. An empty name resolves to the package folder, which `Bun.file().exists()` reports as absent, as for a source install.
- `merge.ts:32`, ConditionalExpression on `result.status === "completed"` in `localHead`. Why: a result that did not complete has no exit code, so `result.exitCode === 0` alone already returns null. The tests prove the `||` mutant and a nonzero exit code.

#### modules/pull-requests/owner.ts

- `owner.ts:36`, ConditionalExpression on `result.status === "completed"` in `git`. Why: as for `merge.ts:32`.
- `owner.ts:53`, ConditionalExpression on `row.worktreePath !== null`. Behavior: a launch without a recorded worktree never matches. Why: `realPathOrNull(null)` is null and never equals the caller's real top level. The check stays for the type narrowing of the match.
- `owner.ts:86`, ConditionalExpression and LogicalOperator on `common !== null && controller !== null`, and `owner.ts:88`, ConditionalExpression on `controller !== null`. Behavior: the worktree shares the controlling checkout's repository. Why: the caller's real top level is this worktree, so Git names its common folder, and a null controller folder has a null real path that never equals it. The next line is a guard string in `run.pull-request-guards.test.ts`, so the comparison keeps its text.

#### modules/pull-requests/relay.ts

- `relay.ts:125`, ArrayDeclaration and StringLiteral on the `git cat-file -e <parent>^{commit}` arguments, and `relay.ts:127`, ConditionalExpression on `!local.ok`. Behavior: a parent head that the clone already holds is not fetched. Why (no rule): Git fetches a commit that the clone already holds without a failure, so the check only saves a network read, and Operator promises no fetch count. The test `a parent head that only the remote holds is fetched before the rebase` proves the fetch path.

### Release group suppressions

- `modules/global-launcher/plan.ts:87`, ConditionalExpression on `facts.globalRoot === null`.
  Behavior: refuse a package that is not in Bun's global folder.
  Equivalent: with no global root, `expected` is null and never equals the package root (a string), so the second test refuses with the same detail.
  The guard string `facts.packageRoot !== expected` in `modules/operator-cli/run.launcher-guards.test.ts` keeps this form.
- `modules/global-launcher/main.ts:58`, ConditionalExpression on `result.status === "completed"`.
  Behavior: a Bun query that did not complete gives no folder.
  Equivalent: only a completed run has an exit code, so any other run also fails `result.exitCode === 0`.
- `modules/global-launcher/main.ts:124`, ArrowFunction on `stat(found).catch(() => null)`.
  Behavior: a command that vanished between the PATH lookup and the read counts as no launcher.
  No rule: Bun.which found the command, so stat fails only when it is removed during the check. No test controls that race, and Operator promises nothing for it.
- `modules/global-launcher/main.ts:126`, OptionalChaining on `entry?.isFile()`.
  Behavior: same race as above.
  No rule: the entry is null only when the command is removed during the check.

### review-requests suppressions

Each line names the comment line. The disable applies to the line below it. There is no file with a no-logic marker.

#### request.ts

- `request.ts:164`, ConditionalExpression. Behavior: the `observed !== undefined` check before a head-move update. Equivalent: the machine decides a head move only when the observed head equals the recorded head, so a decided head move always has an observed head.
- `request.ts:208`, ConditionalExpression. Behavior: the `request === null` check that skips the transition fields for a new request. Equivalent: a change ignores the update of an inserted request, and only a round or a head move reads the request. The machine never decides those for a missing request.

#### post.ts

- `post.ts:98`, ConditionalExpression. Behavior: the `approvalBlocked` guard in `approval`. Equivalent: `decideEvent` never computes an approval with an open blocker. The guard holds only against a later rule change, so no input reaches it. The reason `review_approval_blocked` stays documented in 253.
- `post.ts:100`, ObjectLiteral. Behavior: the refusal object of that guard. Equivalent: same reason as line 98.
- `post.ts:102`, StringLiteral. Behavior: the reason `review_approval_blocked`. Equivalent: same reason as line 98.
- `post.ts:104`, StringLiteral. Behavior: the detail of that refusal. Equivalent: same reason as line 98.
- `post.ts:302`, StringLiteral. Behavior: the `"\0"` fallback of `operation.marker` in `reconcile`. Equivalent: a reply operation always has its marker. A guard in `run.review-round-guards.test.ts` patches this exact text, so the line keeps it.
- `post.ts:436`, ConditionalExpression. Behavior: the `planned === null` check after the post write. Equivalent: `apply` runs the payload for every decided post, so a decided post always has its plan.
- `post.ts:537`, ObjectLiteral and StringLiteral. Behavior: the `lostRequest` failure. Equivalent: the machine refuses a post of a missing request, so no post reaches this failure.
- `post.ts:560`, ConditionalExpression. Behavior: the `request === null` check in `post`. Equivalent: same reason as line 537.

#### review-machine.ts

The tables use `facts.request?.…` because a fact can name no request. Every table that reads the request after its first rule starts with the missing-request rule, or the helper is called only for a listed request. The guard tests patch several of these lines exactly, so the optional chains stay.

- `review-machine.ts:83`, OptionalChaining. Behavior: `request?.launchState` in `starting`. Equivalent: a start is checked only after the missing-request rule, or for a listed request.
- `review-machine.ts:88`, OptionalChaining (two mutants). Behavior: `request?.launchState` in `stopped`. Equivalent: same reason as line 83.
- `review-machine.ts:97`, OptionalChaining. Behavior: `facts.request?.launchState` in `startRound`. Equivalent: a round starts only for a recorded request.
- `review-machine.ts:111`, OptionalChaining. Behavior: `request?.state` in `movable`. Equivalent: a head move is checked only after the missing-request rule.
- `review-machine.ts:145`, `:152`, `:191`, `:241`, `:250`, `:260`, `:318`, `:320`, `:329`, OptionalChaining. Behavior: `facts.request?.state`, `?.sync` or `?.launchState` in an end, start, post, round, or head-move rule. Equivalent: every rule after the missing-request rule reads a recorded request.
- `review-machine.ts:176`, `:199`, `:267`, OptionalChaining and StringLiteral. Behavior: `facts.request?.state ?? ""` inside an `includes` list check. Equivalent: same reason. The fallback text never applies.
- `review-machine.ts:275`, OptionalChaining and StringLiteral. Behavior: `facts.request?.state ?? "missing"` in the `review_already_posted` detail. Equivalent: same reason. The fallback text never applies.
- `review-machine.ts:303`, StringLiteral. Behavior: the `?? ""` fallback of the launch state in `post_failed`. Equivalent: no recorded launch state is the empty text, so a missing request matches neither listed state either way.
- `review-machine.ts:363`, ConditionalExpression and StringLiteral. Behavior: the `review_defect` refusal when no rule matches. Equivalent: every table ends with a rule that always matches.

#### main.ts

- `main.ts:78`, OptionalChaining. Behavior: `current.request?.head` for a replacement start. Equivalent: a start that the machine allows always reads its request.
- `main.ts:87`, OptionalChaining and StringLiteral. Behavior: `snapshot.request?.id ?? ""` for the start lease. Equivalent: same reason. The fallback never runs.

#### watch.ts

- `watch.ts:76`, OptionalChaining. Behavior: `current.request?.launchState` in the interrupt change. Equivalent: the change reads the listed request by its id, so the request always exists.
- `watch.ts:89`, ObjectLiteral and BooleanLiteral. Behavior: the initial `{ stale: false }` flag. Equivalent: the change decision always sets the flag before a successful write reads it, and a failed write reports nothing either way.
- `watch.ts:95`, OptionalChaining. Behavior: `current.request?.state` in the stale mark. Equivalent: same reason as line 76.
- `watch.ts:199`, OptionalChaining. Behavior: `current.request?.cleanupState` in the cleanup claim. Equivalent: same reason as line 76.
- `watch.ts:205`, OptionalChaining. Behavior: `claimed.value.request?.ownerPid`. Equivalent: same reason as line 76.

#### slack.ts

- `slack.ts:117`, StringLiteral. Behavior: the `pr.author ?? ""` fallback in the author policy. No rule: the policy lists GitHub logins. Operator promises nothing for a policy entry that matches the fallback text. A guard patches this line exactly.
- `slack.ts:170`, ObjectLiteral. Behavior: the fallback watch in `ingest`. Equivalent: `startSlackWatch` records the watch just before, so the fallback is never read.
- `slack.ts:234`, ConditionalExpression and StringLiteral. Behavior: the `acknowledge` decision maps an outcome that is not done to a failure. Equivalent: the device-state owner records any outcome that is not done as a failure with its detail.

#### slack-input.ts

- `slack-input.ts:29`, Regex. Behavior: the `$` anchor of the header pattern. Equivalent: text after a header on its line never starts with a TS line, so it joins the message before it either way. The disable also covers the other Regex mutants on that line. Tests kill them, but this run no longer checks them.
- `slack-input.ts:58`, ConditionalExpression. Behavior: `part.text === undefined` in `channelReadOf`. Equivalent: a part without text parses as no JSON and gives no read.
- `slack-input.ts:67` and `:69`, StringLiteral. Behavior: the `= "0"` and `= ""` defaults when `compareTs` splits a ts. No rule: split always gives the seconds, and every Slack ts that Operator compares has its fraction.
- `slack-input.ts:101`, StringLiteral. Behavior: the `preamble = ""` default. Equivalent: split always gives a first part.
- `slack-input.ts:109`, MethodExpression. Behavior: `.trim()` in the TS-line check. Equivalent: the TS pattern starts at the line start with `\s*`, so the text before a match is never only whitespace. A guard patches this line exactly.
- `slack-input.ts:113`, StringLiteral. Behavior: the `ts[1] ?? ""` fallbacks. Equivalent: a TS match always captures its ts group.
- `slack-input.ts:131`, ConditionalExpression. Behavior: `read === undefined` in the refusal check. Equivalent: an undefined read always gives null messages. A guard patches this line exactly.
- `slack-input.ts:163`, ConditionalExpression. Behavior: `part.text === undefined` in `readWrapped`. Equivalent: a part without text parses as no JSON and gives null.
- `slack-input.ts:228`, EqualityOperator. Behavior: `> 0` in `newest`. No rule: two equal ts values name the same moment, so either one is the newest.

### Suppressions: tooling group

- `scripts/mutation-policy.ts:24`, ArrayDeclaration. Behavior: `comments ?? []` falls back to an empty list. Why: Babel's `parse` always returns a `comments` array for a parsed file, so the fallback never runs. The fallback exists only because the Babel type marks `comments` optional. No input reaches the replacement `["Stryker was here"]`.
- `scripts/mutation-policy.ts:37`, OptionalChaining. Behavior: `comment.loc?.start.line` reads the comment line. Why: Babel always sets `loc` on a parsed comment, so `comment.loc.start` gives the same result for every input. The optional chain exists only because the Babel type marks `loc` optional.
- `scripts/mutate.ts:101`, ArrayDeclaration. Behavior: `reporters: []` turns off the Stryker reporters. Why: the replacement `["Stryker was here"]` names no known reporter. Stryker skips it with a warning, and the `error` log level hides the warning, so no file and no output changes.
- `scripts/mutate.ts:108`, StringLiteral. Behavior: `tsconfigFile` names `no-tsconfig.json` in the temporary folder. Why: with the replacement the path is the temporary folder itself. Neither path is a tsconfig file inside the sandbox, so Stryker rewrites no tsconfig in both cases.
- `tools/oxlint/anti-slop/array-method.ts:47`, ConditionalExpression. Behavior: `property.type === "Literal"` guards the computed string method name. Why: no other member property node (identifier, private name, template, or other expression) carries a string `value`, so `isText(property.value)` alone gives the same answer for every input. The check stays only to narrow the TypeScript type. The redundant `node.computed &&` check was removed, because a literal property is always computed.
- `scripts/mutation-selection.ts:111`, ConditionalExpression, StringLiteral. Behavior: an error from `git ls-files --others` stops the selection. Why: this listing runs after `git diff --name-only` against the same index and exclude files. Every way to make the listing fail that was tried (corrupt index, an exclude file that is a folder, a `core.excludesFile` that is a folder) fails the earlier diff first, so the selection returns the same Git error with or without this check.
- `tools/oxlint/anti-slop/reflect-method.ts:13`, ConditionalExpression. Behavior: `member.object.type !== "Identifier"` refuses a non-identifier receiver. Why: only an identifier has a `name`, so the next check, `member.object.name !== "Reflect"`, already refuses every other receiver. The check stays to narrow the TypeScript type. The suppression also hides the killable `true` form on this line.
- `tools/oxlint/anti-slop/reflect-method.ts:20`, OptionalChaining. Behavior: `!variable?.defs.length` treats a missing binding as the global. Why: the scope manager always declares the built-in `Reflect` global, so the binding is never null and `variable.defs` gives the same result.
- `tools/oxlint/check.ts:22`, OptionalChaining. Behavior: a finding without a label is reported on line 0. Why (no rule): the test helper promises a line for each finding of a probe, and no probe produces an Oxlint diagnostic without a label, so no test can reach the fallback.
- `scripts/mutate.ts:122`, ConditionalExpression, StringLiteral, BlockStatement. Behavior: the `NoCoverage` branch counts an untested mutant. Why: coverage analysis is `off`, so Stryker runs every test for every mutant and never reports `NoCoverage`. The `true` form of ConditionalExpression is killable but shares the mutator name.
- `scripts/mutate.ts:124`, UpdateOperator. Same reason: the `NoCoverage` branch never runs.
- `scripts/mutate.ts:126`, StringLiteral, CallExpression. Same reason: the `NoCoverage` line is never printed.
- `scripts/test-watchdog.ts:28`, MethodExpression. Behavior: the silence flag is not passed to `bun test`. Why (no rule): `bun test` ignores an unknown flag, so with `endsWith` the passed-through flag changes no result.
- `scripts/test-watchdog.ts:32`, StringLiteral. Behavior: `FORCE_COLOR=1` on a terminal. Why: Bun forces color when `FORCE_COLOR` is set, also to an empty value.
- `scripts/test-watchdog.ts:66`, StringLiteral. Behavior: a blank line before the stall report. Why (no rule): it only separates the report from the dots.
- `scripts/test-watchdog.ts:91`, EqualityOperator. Behavior: `<` against the silence limit. Why: the check runs once a second on a millisecond clock, so no run lands on the exact limit.
- `scripts/test-watchdog.ts:94`, CallExpression. Behavior: `clearInterval` after a stall. Why: stop kills the child, and the process exits before the next one-second check.
- `tools/oxlint/anti-slop/validator-subject.ts:33`, ConditionalExpression. Behavior: `resolved.type !== "TSTypeReference"` stops the broad-target check for other types. Why: any other type has no type name, so the `isGlobalType` name checks after it refuse that type too. The check stays to narrow the TypeScript type.
- `tools/oxlint/anti-slop/validator-subject.ts:61`, ConditionalExpression, LogicalOperator. Behavior: `predicate.parameterName.type !== "Identifier" || !predicate.typeAnnotation` refuses a `this` predicate or a predicate with no type. Why: a `this` predicate names no parameter, so no parameter matches later, and a predicate that is not `asserts` always has a type. The check stays to narrow the TypeScript type.
- `tools/oxlint/anti-slop/validator-subject.ts:81`, ConditionalExpression. Behavior: `parameter.type !== "Identifier"` skips destructured and rest parameters. Why: only an identifier parameter has a name, so the name check alone refuses the others. The check stays to narrow the TypeScript type.
- `tools/oxlint/anti-slop/no-unknown-returns.ts:13`, ConditionalExpression. Behavior: `type.type === "TSTypeReference"` guards the Promise name check. Why: any other type has no type name, so the name check refuses it. The check stays to narrow the TypeScript type.
- `tools/oxlint/anti-slop/no-runtime-typeof.ts:9`, ConditionalExpression. Behavior: `parent.type !== "BinaryExpression"` refuses other parents of `typeof`. Why: no other parent has an equality operator, so the operator check refuses it. The check stays to narrow the TypeScript type.
- `tools/oxlint/anti-slop/no-runtime-typeof.ts:13`, ConditionalExpression. Behavior: `other.type === "Literal"` guards the `"undefined"` comparison. Why: only a literal can have the string value `"undefined"`. The check stays to narrow the TypeScript type.
- `tools/oxlint/operator/env-through-schema.ts:58`, ArrayDeclaration. Behavior: `defaultOptions: [{ allowFiles: [] }]` gives an empty allow list by default. Why: the replacement list holds `"Stryker was here"`, and Oxlint lints only source files, so no linted path ever equals that text.
- `tools/oxlint/operator/env-through-schema.ts:86`, ConditionalExpression. Behavior: `property.key.type === "Literal"` guards the literal `"env"` key check. Why: only a literal key can have the value `"env"`, so the value check alone gives the same answer. The check stays to narrow the TypeScript type.

### Suppressions of group work-sources

| file:line | mutator | behavior | why no test can distinguish it |
| --- | --- | --- | --- |
| modules/report-assignments/main.ts:31 | ArrowFunction | `stop` restates a failed step result as the command result: `result.flatMap(() => stop(result))`. | equivalent: the callback runs only for a success, and every caller passes only an Err or a Defect. |
| modules/report-assignments/main.ts:200 | OptionalChaining, StringLiteral | The inserted report row takes `current.launch?.id ?? ""`. | equivalent: the submit rule needs a running launch, so the launch is never null at this point and the fallback never applies. |
| modules/report-assignments/main.ts:294 | OptionalChaining | A return tells whether the worker is live: `facts.launch?.state === "running"`. | equivalent: a submitted report always has the launch that submitted it, so the launch is never null. |
| modules/work-sources/assignment-machine.ts:125 | OptionalChaining | The cleanup retry reason reads `report?.cleanup`. | equivalent: the rule's condition matches only when a report exists. |
| modules/work-sources/main.ts:245 | ArrayDeclaration | `let preserved: string[] = []` before reset. | equivalent: the reset rule sets the list before any success reads it. A refusal never reads it. |
| modules/work-sources/main.ts:247 | ArrayDeclaration | `let abandoned: string[] = []` before reset. | equivalent: as above. |
| modules/work-sources/main.ts:257 | ArrowFunction | The stored plan read during reset qualifies every failure as `null`. | equivalent: every non-Ok result, `null` or `undefined` error alike, ends as the same `state_corrupt` refusal. |
| modules/work-sources/main.ts:287 | ArrayDeclaration | The reset result computes `prunableAt` through `retention` with empty launches, cleanups, and reports. | equivalent: the prunable time depends only on the state and the end time, never on those lists. |
| modules/work-sources/main.ts:330 | ArrowFunction, ObjectLiteral | A prune defect is restated with `result.map(() => ({ pruned, kept }))`. | equivalent: the map callback never runs for a Defect. A test asserts that the original cause stays. |

No `// Stryker disable all: no logic` markers were added.

