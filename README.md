# Operator

Personal skills and CLI tools for coordinating coding agents in OpenCode and Claude Code through [Herdr](https://herdr.dev/).

## Breaking replacement in progress

Issue [#234](https://github.com/fveracoechea/operator/issues/234) defines the device-level replacement.
This branch starts with [#235](https://github.com/fveracoechea/operator/issues/235), which removes the legacy architecture before new workflows land.
It is not an intermediate release.
Only help and version reporting are available in this slice.

Finish old work with the old release before updating to the eventual breaking release.
This code does not inspect, migrate, repair, or delete legacy Operator state.
Do not use it to resume an old session.

The device-level design in `CONTEXT.md` and `docs/adr/` remains planned.
The base lint policy in ADR-0018 is now enforced.
Device settings, registration, migrations, launch profiles, personal skill installation, assignments, reviews, and the global Herdr plugin are not implemented here.
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

## Release tooling

The existing Changesets workflow remains automatic after a merged version change passes quality and release smoke.
It uses pinned actions and the exact official JSR client with short-lived credentials.
Publication refuses conflicting tags or versions, and retries supply only missing delivery.

```sh
bun scripts/release.ts build --out dist --commit <full-commit>
```

Build writes runnable ESM, declarations, complete retained skills, documentation, and a content-identified release record.
The removed configuration schemas and old Herdr hooks no longer ship.
The maintainer-only `plan` and `publish` operations remain in `scripts/release.ts` for the release workflow.
Do not publish this partial implementation.
