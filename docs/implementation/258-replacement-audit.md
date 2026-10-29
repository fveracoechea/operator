# Replacement audit, issue 258

This is the final bounded audit of the device-level replacement in #234, on `global-operator-home` in PR #222.
It is not the main legacy removal. #235 removed the legacy architecture, and each functional slice removed its own obsolete callers.
This audit deletes only what it found unused or duplicated, and it corrects stale documentation.
It makes no release or merge claim. Installed delivery and release belong to #259, and mutation survivors to #260.
No real Operator settings, device records, or legacy checkout state were inputs to this work.

## Inventory

The audit covers tracked source at `5308c6b` plus the changes of this slice.

| Area | Finding | Disposition |
| --- | --- | --- |
| Role names in CLI, JSON, database, plugin, skills, and docs | `crew`, `operative`, and `frontier` appear only in `_Avoid_` glossary entries, historical implementation records, refusal tests for removed commands, and the #242 removal of unchanged retired `operator` and `operative` skill copies. `--role` accepts only `superAgent` and `workerAgent`. Matches of "frontier" in `.agents/skills/` and `docs/agents/` are upstream planning vocabulary, not Operator roles. | Kept. No alias, forwarding skill, or compatibility path exists. |
| Product identifiers | `operator`, `@fveracoechea/operator`, `OperatorHome`, `OperatorRelease`, and `operator.sqlite` name the product, not a role. | Kept. |
| Removed machinery | No source outside tests names setup, tracker recovery, integration publication, local gates, live probes, rework, result review, grants, questions as records, ownership replay, quotas, write-path scheduling, outside scanning, or planning records. The words that do match are current behavior, for example the `pr_base_invalid` refusal of an integration-branch base and the brief text about questions to the SuperAgent. | Kept. `run.test.ts` refuses 26 removed or invalid command forms with no writes. |
| Legacy checkout state | Only `projects/checkout.ts` looks at `.operator`, by presence alone, and refuses with `legacy_project_state`. | Kept. |
| Module use | Every module `main.ts` has a production importer outside its module. | Kept. |
| Test-only interface members | `ReleasePublish.pack` is the installed delivery smoke seam. `ReleasePublish.delivered` is not test-only: `scripts/release.ts verify` reads the publication journal through it. `Environment.parse` validates a supplied environment for isolated tests and the #219 validator exception. | Kept. #259 owns release publication. |
| Duplicate helpers | `slug` had exact copies in `review-requests/reviewer.ts` and `worker-dispatch/names.ts`. `realOrNull` had exact copies in `pull-requests/owner.ts`, `pull-requests/cleanup.ts`, and `worker-dispatch/observations.ts`. | Moved to `lib/slug.ts` and `lib/real-path.ts` with beside-tests. Neither owns application functionality. |
| Duplicate in one module | `failureOf` had exact copies in `review-requests/reviewer.ts` and `review-requests/watch.ts`. | `watch.ts` imports the one in `reviewer.ts`. It stays in its module, because it names the `review_defect` reason. |
| Similar helpers kept apart | Each module's `git` wrapper over `ToolInvocation.run` sets its own timeout and maps failures to that module's reasons. Each CLI `exitCode` maps a different reason set. Each module's `qualify` maps a different errno set to that module's reasons. | Kept with their modules. A shared wrapper would need each caller's failure map. |
| `lib/` | `coded-error.ts`, `real-path.ts`, `sha256.ts`, and `slug.ts`. None imports an application module or tooling. | Kept. `lint:modules` and Oxlint enforce the boundary. |
| Reverse imports, private imports, barrels | `lint:modules`, `test:module-boundaries`, and the #219 boundary lint rules pass. | No change. |
| Command examples | Every `operator` or `bun cli.ts` example in the docs, the owned skills, and the agent instructions, and every command that a next action, a refusal, or a brief names, is an implemented command. | New guard in `modules/operator-cli/run.command-examples.test.ts`. |
| Role skills | `super-agent` and `worker-agent` name only implemented commands. Commands that they do not name, for example `config show`, `host models`, and `herdr event`, are reached through `operator --help`, which both skills require. | No change. |
| README | It still said "including setup" for refusals before registration, called the device-level design planned, omitted source reset, prune, and Slack transport from the available list, and said role skills arrive later. | Corrected. `docs/jsr/README.md` is a link to it. |
| ADR status lines | ADR-0001, 0003 to 0011, and 0014 to 0019 said planned or partly implemented, although their slices landed. | Each names the issues that implement it. |

## Command example guard

The guard runs the public `operator --help` in an isolated registered device and parses each usage line into command names, for example `review add` and `review post`.
It then scans root Markdown and Markdown under `docs/`, `skills/`, and `agents/`, except `CHANGELOG.md`, and every non-test file under `modules/` and `cli.ts`.

- In Markdown, it reads code spans and shell fence lines that start with `operator` or `bun cli.ts`. A plain word after a command with no subcommand fails, so a `cleanup remove` example fails.
- In source text, prose can follow a command with no subcommand, for example "Read operator next later". An unknown group or subcommand fails, so "Read operator work frontier later" fails.
- The guard checks command names, not flags or arguments. A `source prune now` example passes the guard, and the CLI refuses it with exit 2.

## Verification

Verified on macOS with Bun 1.4.4.

| Command | Result |
| --- | --- |
| `bun test lib/` | Passed, 4 tests, including the new `slug` and `realPathOrNull` beside-tests. |
| `bun test modules/operator-cli/run.command-examples.test.ts` | Passed, 4 tests. |
| Deliberate break: a `crew next` example in `skills/super-agent/sources.md` | Red. The guard named the skill line. Restored. |
| Deliberate break: a `review report` example in `README.md` | Red. Restored. |
| Deliberate break: "Read operator work frontier later" in `modules/device-state/cleanups.ts` | Red. Restored. |
| Deliberate break: a `review slack-sent` command in `modules/review-requests/slack.ts` | Red. Restored. |
| Deliberate break: "with operator clean first" in `modules/device-state/projects.ts` | Red. Restored. |
| Deliberate break: remove the `review ingest` usage line from `modules/operator-cli/run.ts` | Red. The guard named the Slack skill, the #255 record, and the `slack.ts` next action. Restored. |
| `bun run quality` through the locked gate | Passed. All static checks, 17 rejected deliberate module-boundary violations, and 1295 tests across 160 files with 0 failures. No flaky test was observed. |
| `bun run quality:static` after the last documentation edits | Passed. |
| `git diff --check` | Passed. |

No release was published, no pull request was merged, and no real legacy state was changed.
