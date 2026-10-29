# Installed delivery and the breaking release

Issue #259 proves the documented workflows through installed commands on each delivery path and both hosts.
It also prepares the breaking 1.0.0 release and the release checks that need the real JSR service.
It does not publish a release, merge PR #222, or change a real installation, Herdr server, or Nix configuration.

## Candidate

The candidate is the build of the `global-operator-home` commit that carries this change.
Its manifest version is 0.9.0, because Changesets applies the version only in the version pull request after PR #222 merges.
`bunx --bun @changesets/cli@3.0.3 status --verbose` reports `@fveracoechea/operator -> 1.0.0` from the major changeset `.changeset/device-level-release.md` and the two pending patch changesets.
A run of `changeset version` on a scratch copy wrote version 1.0.0, consumed all three changesets, and wrote a `## 1.0.0` section with the update instructions.
The 1.0.0 artifact has another identity than the tested 0.9.0 build, because the identity covers the version.
The release smoke checks that artifact again on the version pull request, and `release verify` checks it after the publication.

## Breaking changeset

`.changeset/device-level-release.md` replaces the earlier major changeset of #235, which described only help and version reporting.
It declares `major`, lists the replaced workflows, and tells consumers to finish all old crews and their work with the old release before they update.
It states that the new release does not migrate, repair, or delete legacy checkout-local `.operator` state, and that it refuses to register such a checkout.

`scripts/breaking-release.test.ts` guards this text in both states of the release.
While the manifest version is `0.x`, a pending major changeset must hold the two instructions.
After the version pull request, the `## 1.0.0` notes in `CHANGELOG.md` must hold them, so the guard does not fail on that pull request.

## Installed workflow smoke

`modules/operator-release/installed-workflows.test.ts` builds the candidate with `OperatorRelease.build` and installs it twice in isolated Bun, settings, and state roots:

- JSR: `bun add -g` of the exact version from the local registry fake that rewrites the manifest as JSR does, then `project register` and `install launcher` through `cli.js`.
- Source: `bun add -g git+file://<staging>#<full commit>`, then the staging clone is removed.

For each path, one test runs registration, a refused legacy checkout, version JSON, `project show`, a settings plan and apply with a named Claude Code profile, `host models` for both hosts, and `config resolve` for the SuperAgent and the profile.
Two more tests run the CLI workflow tests again in a child `bun test`, with `OPERATOR_INSTALLED_COMMAND` set to the installed `operator`:

- `run.delegated-run.test.ts`, the tests that run one report and two reviewed PRs to a finished source on OpenCode and on Claude Code. They dispatch, submit and accept a report, associate PRs, wait for feedback, merge, and clean up.
- `run.reviews.test.ts`, the manual review request on OpenCode and on Claude Code. It adds, starts, and posts a review.

`modules/operator-cli/command-fixture.ts` reads that variable for the worker and review fixtures, so every fixture command and the Herdr hook run the installed command.
The fixture links `operator` on the tool path to the same command.
Readiness accepts only a command that runs the running release, and the delegated run requires `ready`, so a fixture that ran the checkout would fail.
The CLI never reads the variable.

`modules/operator-release/install-fixture.ts` holds the release build, the isolated device, and the registry setup that `global-delivery.test.ts` and the new tests share.

## Defect found

On the JSR path, cleanup after `pr merge` never started, and each merged PR stayed at `retry_cleanup` in `next`.
`pull-requests/merge.ts` started the detached cleanup with `../../cli.ts`, and a built release has only `cli.js`.
The installed delegated run reproduced it: the JSR child run failed with two extra `cleanup` commands, and the source child run passed.
`merge.ts` now starts `cli.js` when the package has it, and `cli.ts` otherwise.
After the fix the JSR child run passed.
No other production file starts a CLI process by path.

The first CI run of this change, run 40725446916, found a second defect, in the new `release verify`.
On the Linux runner, the second install attempt read the manifest from Bun's cache and asked the registry nothing, so a retry could never see a version that JSR published after the first attempt.
Each attempt now uses its own empty Bun cache, and `registry-install.test.ts` requires one registry manifest read for each attempt.

A local quality run found a Git race in the source path delegated run.
The detached cleanup of the first merged PR ran `git worktree remove`, Git deleted the then empty `.git/worktrees` folder, and the dispatch of the second PR ran `git worktree add` at the same moment.
`herdr worktree create` failed with `could not create directory of '.git/worktrees/pr-one-33-document': Invalid argument`, and Operator recorded `launch_failed`.
The slower start of an installed command made this order possible.
Real Herdr runs the same Git commands, so the race can occur on a device. Operator then offers `replace_worker`, which is the designed recovery.
`run.delegated-run.test.ts` now waits for the cleanup after each merge before the next dispatch, so it proves the routine path only.
Operator does not serialize a cleanup with a worktree start of the same repository. #266 tracks the fix, with the reproduction, and removes the wait.

## Release automation

| Stage | Check | Service |
| --- | --- | --- |
| Each pull request, and `release.yml` before `publish` | `release-smoke.yml` job `jsr-client`: build, then `bun run --bun release check --out dist`. The pinned `jsr` client runs `publish --dry-run` in a staged copy. | Real JSR client. No credential, no upload. |
| Each pull request, and before `publish` | `delivery`: the release tests, including the installed workflow smoke, against the registry fake. | None. |
| Each pull request, and before `publish` | `nix`: the flake checks, the workflow tests through `result/bin/operator`, and the `diff -r` of the artifacts on both systems. | GitHub archive of the commit. |
| Right after this commit's publication | `release.yml` step `Install the published version from JSR`: `bun scripts/release.ts verify --out dist`. | Live `npm.jsr.io`. |

A partial publication exits 6, so the `verify` step does not run in that attempt. The rerun of the same commit recovers the record, publishes the missing path, and then runs `verify`.

`release verify` reads the publication record of the commit.
When the record holds no published JSR path, it reports `nothing_published` and exits 0, so a push that publishes nothing passes.
Otherwise `OperatorRelease.verifyRegistryInstall` installs the exact version with Bun from the registry in isolated roots, registers a scratch checkout, and reads `--version --json`.
The version, the commit, and the artifact identity must match the record.
It tries the install up to 20 times, 30 seconds apart, because JSR builds the npm tarball after the publication.
Each install attempt stops after 2 minutes and each CLI command after 30 seconds, and the step has `timeout-minutes: 20`, so a stalled registry cannot hold the publication group.
A failure is red, and the next step still keeps the publication record.
It cannot repair a published version, because versions are immutable. The person publishes a fixed version.
A publication cannot be verified from the live registry before it exists, so this is the earliest valid stage for that check.

Publication itself is unchanged: the merged version pull request publishes automatically after quality and the release smoke, with the pinned official client and the short-lived OIDC credential.
A tag is never moved, a held version is never replaced, and a retry sends only the missing path.
The existing `release-publish/main.test.ts` tests prove these rules, and four new tests prove the client check, its refusal, the smoke job, and the order of the `verify` step.

## Real service evidence

Read on 2026-10-28:

- `curl -s https://npm.jsr.io/@jsr/fveracoechea__operator`: versions 0.1.0 to 0.9.0, `latest` 0.9.0.
- `https://api.jsr.io/scopes/fveracoechea/packages/operator/versions/1.0.0`: 404. The candidate is not published.
- `bun add -g "@fveracoechea/operator@npm:@jsr/fveracoechea__operator@0.9.0"` with the JSR scope in isolated Bun folders: installed. The installed manifest has no `bin`, `engines`, or `scripts` field, Bun linked no command, and the global manifest names the exact specifier. This is the old release, so it shows only the registry install behavior that the fake copies.
- The pinned `jsr` 0.14.3 client ran `publish --dry-run` on the staged candidate artifact under Bun: `Success Dry run complete` for `@fveracoechea/operator@0.9.0`, with one warning, `unsupported-javascript-entrypoint` for `cli.js`. The warning is older than this change. It does not stop publication.

Evidence gap: no live registry install of the candidate ran, because the candidate is not published.
The deterministic registry fake is the candidate evidence, and `release verify` closes the gap after the publication.

## Live Herdr check

Herdr 0.9.3 on macOS, with an isolated `herdr server` whose HOME and XDG folders were also the Operator device roots, and a candidate JSR install from the registry fake in isolated Bun folders.
The server's `PATH` held only Bun's global bin folder, links to `bun`, `git`, and `herdr`, `/usr/bin`, and `/bin`.
The person's Herdr server and Operator installation were not used.

| Step | Observed result |
| --- | --- |
| Before the launcher | No `operator` on `PATH`. |
| `bun <global>/cli.js project register`, then `install launcher` | `project_registered`, then `launcher_installed`. |
| `operator --version --json` through the launcher | Version 0.9.0, the candidate commit, and its artifact identity. |
| `operator herdr install` | `herdr_plugin_linked`. `herdr plugin list` showed the four hooks on `operator herdr event --json`. |
| `herdr worktree create --branch live/1` | Herdr ran the hook through the launcher: exit 0, `worktree_prepared`. `.env.local` was copied and `.env` was not. |
| `herdr pane close` of the worktree pane | Hook exit 0, `herdr_pane_exited`. |
| `operator ready --json` | No `operator` blocker. Only `gh` and the host checks blocked, because the server path had neither. |

A first attempt ran the Herdr server with other HOME and XDG folders than Operator.
The hook then ran through the launcher with exit 0 and answered `herdr_event_ignored` with `stateMissing`, because that environment had no device state.
Herdr and Operator must share HOME and the XDG folders, which a normal device does.

## Matrix

| Path | Host | Workflow | Result | Evidence |
| --- | --- | --- | --- | --- |
| JSR, registry fake | both | registration, settings, profiles, host models, dispatch, report, PR merge and cleanup, review add, start, post | Passed | installed workflow smoke |
| Source at a full commit | both | the same | Passed | installed workflow smoke |
| JSR and source | both | review rounds, PR relay, reports, source reset | Passed once, not in the suite | full workflow files through each install, see verification |
| Nix, both systems | controlled tools | version, artifact, dependencies, discovery with linked and copied skills, check-only install | Passed in CI | run 40726892626 |
| Nix, both systems | both | registration, profile, readiness, dispatch, report submit, accept, return, and resume, two reviewed PRs with merge and cleanup, review add, start, post | Passed in CI | `nix` job step `Run the workflows through the Nix command`, run 40732728179 |
| JSR, registry fake | real Herdr | worktree hook, pane close, discovery through `PATH` | Passed | live Herdr check |
| Source | real Herdr | worktree hook, pane close | Passed in #247 | `247-dispatch.md` |
| Nix | real Herdr | hooks | Not run | Nix is not run on this device. The flake `discovery` check uses a controlled `herdr`. |
| JSR, live registry | any | candidate install | Blocked until publication | `release verify` after publication |
| any | OpenCode, live | launch | Not run | The installed OpenCode has no `api` or `mini` command, see #247. |
| any | Claude Code | Slack review transport | Live tool contract in #255 | Slack is Claude Code only. OpenCode readiness and workflows need no Slack tool, and the OpenCode runs above had none. |

Settings that Nix or Home Manager manage stay read-only: `run.settings.test.ts` refuses an apply on a linked settings file with `settings_external` and leaves the link and its target unchanged.
The Nix `discovery` check covers the Home Manager skill shape, a folder of file links, and the plain folder links, and check-only install leaves both host folders unchanged.

## Documentation, examples, and skills

The README installation blocks run as written in `global-delivery.test.ts`.
The command example guard of #258 passes, so every command in the docs, skills, instructions, and next actions is implemented.
The README now says installed delivery is proven and names the release checks.
No diagram changed shape. The module and lib convention is unchanged and `lint:modules` passes.

## Remaining work

#260 clears the mutation survivors on all changed lines. It is the final cleanup task before the delivery PR merges.
Publication, the version pull request, and the merge of PR #222 are the person's actions.

## Verification

Verified on macOS arm64 with Bun 1.4.4, and in GitHub Actions with Bun 1.4.2.

GitHub Actions run 40726892626 ran `release-smoke.yml` on this change through a temporary push trigger on the branch `agent/259-ci`, which was deleted after the run.
All four jobs passed:

- `delivery` on `ubuntu-latest`: 53 tests across 9 files in `modules/operator-release`, including the installed workflow smoke and the registry install tests.
- `jsr-client`: the build and `release check` with the pinned JSR client.
- `nix` on `ubuntu-latest` (x86_64-linux) and `macos-latest` (aarch64-darwin): `nix flake check -L` with the `version`, `artifact`, `dependencies`, and `discovery` checks, `nix build --rebuild`, and both `diff -r` comparisons with the release job's artifact.

GitHub Actions run 40732728179 ran the same jobs after the review changes, with the new `nix` step `Run the workflows through the Nix command`.
That step sets `OPERATOR_INSTALLED_COMMAND` to `result/bin/operator` and runs the delegated run, the manual review, and the report tests: 10 pass, 0 fail on `ubuntu-latest` and on `macos-latest`.
The `delivery` job ran 54 tests with 0 fail, including the stalled registry test.
The temporary branch was deleted after each run.

The earlier run 40725446916 failed only in `delivery`, at the Bun cache defect described above. Nix was not run on this device.

| Command | Result |
| --- | --- |
| `bun test --isolate modules/operator-release/installed-workflows.test.ts` | Passed, 6 tests. |
| Same file, with all six fixture workflow files and no filter, once | JSR: delegated run 3, reviews 18, review rounds 14, PR relay 7, reports 8, source reset 7, all passed. Source: the same counts, all passed. |
| `bun test --isolate modules/operator-release/registry-install.test.ts` | Passed, 4 tests. |
| `bun test --isolate modules/operator-release/global-delivery.test.ts` | Passed, 4 tests, after the move to the shared fixture. |
| `bun test --isolate modules/release-publish/main.test.ts` | Passed, 30 tests. |
| `bun test scripts/breaking-release.test.ts` | Passed. |

Deliberate breaks, each restored after the run:

| Break | Check | Failure |
| --- | --- | --- |
| `merge.ts` never starts `cli.js` | installed workflow smoke, JSR | Both delegated runs fail. This was the original defect. |
| The fixture runs the checkout `cli.ts`, but links the installed command | installed workflow smoke, JSR | Both delegated runs fail, because readiness reports a mismatch. |
| Changeset says `finish old crews` | `breaking-release.test.ts` | The instruction is missing. |
| Changeset declares `minor` | `breaking-release.test.ts` | No pending major changeset. |
| All attempts share one Bun cache | `registry-install.test.ts` on the Linux runner | One manifest read for two attempts. This was the CI finding. |
| `spawn` in `registry-install.ts` has no `timeout` | `registry-install.test.ts` | The stalled registry test runs into its 60 second limit. |
| The `nix` job drops the Nix command workflow step | `release-publish/main.test.ts` | The Nix workflow step test fails. |
| `verifyRegistryInstall` does not compare the commit | `registry-install.test.ts` | The moved commit and the `verify` step mismatch tests fail. |
| `release.yml` runs no `verify` step | `release-publish/main.test.ts` | The step order test fails. |
| The fake client publishes on `--dry-run` | `release-publish/main.test.ts` | The check test sees a published version. |
| `check` runs `publish` with no `--dry-run` | `release-publish/main.test.ts` | The check test fails. |
