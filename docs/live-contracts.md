# Live contract tests

Operator runs three vendor commands that it does not own: Herdr, OpenCode, and Claude Code.
The unit tests replace each one with a controlled fake, so they cannot see a vendor change.
The live contract tests run the installed commands and fail a named test when an answer changes.

They are opt-in.
`bun run test` and CI never run them, because Bun discovers only test and spec files, such as `*.test.ts`.
`operator ready` never runs them either, because readiness checks only static prerequisites ([ADR-0009](adr/0009-readiness-checks-static-prerequisites-without-live-probes.md)).

## Run them

1. Install `herdr`, `opencode`, and `claude`, and put them on `PATH`.
2. Sign in to OpenCode and Claude Code, so each one can list its models.
   Configure the `worker` primary agent in OpenCode before running its startup contract.
3. Run `bun run test:live` from the repository root.

The runner prints the versions it runs against before the tests start.
When a contract fails, it prints the failed test and those versions again, then exits with the test run's code.
When every contract passes, it writes the date, the versions, and the contract files to [live-contracts.json](live-contracts.json).
Commit that file when you want to record a new verified set of versions.

To run one family, pass its file to Bun with a `./` prefix and the runner's timeout, for example `bun test --timeout=60000 ./modules/herdr/main.contract.ts`.
A run of a single file records no versions.

## What they cover

| File | Contract |
| --- | --- |
| `src/modules/herdr/main.contract.ts` | The workspace, tab, pane, worktree, agent, and plugin commands of the Herdr adapter, and the `pane_not_found` answer for a closed pane. |
| `src/modules/worker-dispatch/hooks.contract.ts` | The released plugin manifest. Herdr runs each hook with the event name, the event fields, and the socket path that `operator herdr event` reads. The installed Herdr meets `min_herdr_version`. |
| `src/modules/agent-hosts/main.contract.ts` | OpenCode and Claude Code return model catalogs and accept the launch flags. OpenCode preserves the `worker` agent, model, effort, and directory before full-TUI attachment. |

## What they change

The Herdr contracts start a private Herdr server with its own config folder and home in a temporary folder.
They never use your Herdr session, its panes, or its plugin links, and they remove the folder when they finish.
The host contracts read model catalogs and create and delete an empty OpenCode session.
They send no prompt and start no terminal agent.

Keep each contract beside the module it checks, as `<unit>.contract.ts`.
Name each test after the vendor command it runs, so a failure names the command that changed.
