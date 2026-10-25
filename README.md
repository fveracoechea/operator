# Operator

Personal skills and CLI tools for coordinating coding agents in OpenCode and Claude Code through [Herdr](https://herdr.dev/).

## Breaking replacement in progress

Issue [#234](https://github.com/fveracoechea/operator/issues/234) defines the device-level replacement.
This branch starts with [#235](https://github.com/fveracoechea/operator/issues/235), which removes the legacy architecture before new workflows land.
It is not an intermediate release.
Help, version reporting, and device settings commands are available.

Finish old work with the old release before updating to the eventual breaking release.
This code does not inspect, migrate, repair, or delete legacy Operator state.
Do not use it to resume an old session.

The device-level design in `CONTEXT.md` and `docs/adr/` remains planned.
The base lint policy in ADR-0018 is now enforced.
Local mutation testing from ADR-0016 is also available for repository development.
Registration, migrations, launch profiles, personal skill installation, assignments, reviews, and the global Herdr plugin are not implemented here.
There are no replacement-command placeholders or compatibility aliases.

## Run the retained CLI

From a source checkout at an exact commit:

```sh
bun install --frozen-lockfile
bun cli.ts --help
bun cli.ts --version
bun cli.ts --version --json
```

The CLI requires Bun 1.4.0 or later.
Version output describes the running installation, not a project-selected release.
A built artifact also reports its commit and artifact identity in JSON.
Unknown or removed commands exit with code 2 and perform no workflow operation.
An unsupported Bun exits with code 1 before a command runs.

An installed package exports `main(args)` from `@fveracoechea/operator/cli`.
Source-package installation provides the `operator` binary without an install-time build.
JSR rewrites the package manifest and drops its binary declaration.
The exported CLI remains usable, but the new global JSR launcher and Nix delivery are later implementation slices.

## Device settings

Linux and macOS use the same XDG layout.
Settings are in `$XDG_CONFIG_HOME/operator/config.json`, or `~/.config/operator/config.json` when the variable is unset.
Settings receipts and their SQLite write lock are in `$XDG_STATE_HOME/operator/config/`, or `~/.local/state/operator/config/`.
An explicitly empty or relative root is an error before any command runs.
There is no `OPERATOR_HOME`, cache root, or runtime root.

```sh
bun cli.ts config show --json
bun cli.ts config plan --set superAgent.host=opencode --json
bun cli.ts config apply --set superAgent.host=opencode --plan <plan-id> --json
bun cli.ts config recover --json
```

Use the plan ID returned by `config plan` and repeat the same edits for `config apply`.
`--set` and `--unset` accept `superAgent.host`, `superAgent.model`, `superAgent.reasoningEffort`, and the corresponding `workerAgent` fields.
Hosts are `opencode` and `claude-code`.
Effort values are `low`, `medium`, and `high`.
These commands validate document structure, not host model availability or launch selection, which remain in #241.
An absent document reads as empty role settings and creates no files.
The first applied edit creates the document with `$schema` set to `./config.schema.json`.
An applied edit also writes current editor support unless that destination is linked or read-only.
Inspection and planning write nothing.

Apply refuses a stale plan and protects repeated or interrupted writes with a durable receipt and a process-safe SQLite lock.
Recovery reconciles the receipt from the recorded before and after file identities, without editing settings.
An unmatched or unreadable receipt remains blocked for inspection.
An unconfirmed write exits with code 5 and requires recovery, not a blind new edit.
Linked or read-only settings remain readable, but edits refuse with instructions to change their external owner, such as Nix or Home Manager.
Settings commands do not inspect legacy state or change a project checkout.
See `docs/implementation/239-device-settings.md` for the state diagram and test rules.

## Retained code and checks

Features and capabilities live under root `modules/`.
Each module exposes one interface object from `main.ts`, and other files are private.
Focused reusable functions live under root `lib/`, with direct named imports and beside-tests.
Lib code imports no application module or tooling.

```sh
bun run quality
bun run test:module-boundaries
```

Quality runs formatting, lint, typechecking, structural checks, skill checks, deliberate module-boundary violations, and the remaining tests.
The tests use isolated globals.
Oxlint owns dependency cycles and type-aware code policy, while the module checker owns structural boundaries.
The deliberate-break tests run the real lint command in disposable checkout copies.
See `docs/implementation/237-lint-policy.md` for policy coverage, exception boundaries, and verification.
The installed delivery smoke uses real Bun installs and Git, a local registry fixture, and the built public declarations.
Publication tests use controlled GitHub and official-client commands.
They publish no real release.

See `docs/implementation/235-legacy-removal.md` for the inventory, retained ownership, diagram, and verification results.
`skills/` contains complete owned engineering skills.
The old role and posting-review skills are removed, and replacements arrive with their workflows.

## Local mutation testing

```sh
bun run mutate lib/sha256.ts
bun run mutate lib/sha256.test.ts
bun run mutate --since HEAD
```

Pass explicit unit or beside-test paths, or changed lines against an explicit Git ref.
Only direct same-folder tests count for each unit.
No target is a usage error.
Mutation testing is not part of `quality` or CI and adds no `operator` command.
See [the development mutation topic](.agents/skills/unit-testing/mutation-testing.md) for exits, target rules, and survivor repairs.
The development-only `unit-testing` skill has a Claude Code link and does not ship in the release.

## Release tooling

The existing Changesets workflow remains automatic after a merged version change passes quality and release smoke.
It uses pinned actions and the exact official JSR client with short-lived credentials.
Publication refuses conflicting tags or versions, and retries supply only missing delivery.

```sh
bun scripts/release.ts build --out dist --commit <full-commit>
```

Build writes runnable ESM, declarations, complete retained skills, documentation, and a content-identified release record.
The old project configuration schemas and Herdr hooks no longer ship.
The maintainer-only `plan` and `publish` operations remain in `scripts/release.ts` for the release workflow.
Do not publish this partial implementation.
