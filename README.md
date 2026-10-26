# Operator

Personal skills and CLI tools for coordinating coding agents in OpenCode and Claude Code through [Herdr](https://herdr.dev/).

## Breaking replacement in progress

Issue [#234](https://github.com/fveracoechea/operator/issues/234) defines the device-level replacement.
This branch starts with [#235](https://github.com/fveracoechea/operator/issues/235), which removes the legacy architecture before new workflows land.
It is not an intermediate release.
Help, version reporting, device settings, launch selection, project registration, skill installation, and static readiness are available.

Finish old work with the old release before updating to the eventual breaking release.
This code does not inspect, migrate, repair, or delete legacy Operator state.
Do not use it to resume an old session.

The device-level design in `CONTEXT.md` and `docs/adr/` remains planned.
The base lint policy in ADR-0018 is now enforced.
Local mutation testing from ADR-0016 is also available for repository development.
Automatic migration upgrades, assignments, reviews, and the global Herdr plugin are not implemented here.
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

## Personal owned skills

```sh
operator install --opencode --json
operator install --claude --json
operator install --opencode --claude --json
operator install --opencode --claude --check --json
```

The exported `main` accepts the same arguments when a global launcher is not available.
Owned skills come from the running package, with complete supporting assets copied to personal host locations.
OpenCode uses `$XDG_CONFIG_HOME/opencode/skills/`, or `~/.config/opencode/skills/` when unset.
Claude Code uses `~/.claude/skills/`.
The device ledger permits replacement only of unchanged managed content.
Matching content stays unwritten.
Modified or unrelated contents refuse with exit 4 rather than overwrite your edits.
Old role names are removed only with unchanged device-ledger proof, without forwarding skills or legacy-ledger adoption.

`--check` follows links and compares contents without writing host folders or device state.
Packages under `/nix/store/` always check consumer-owned wiring rather than copy skills.
The role skills are `super-agent` and `worker-agent`.
Workflow commands, Nix packaging, and the global JSR launcher remain in their later implementation tickets.

## Upstream skills and static readiness

```sh
operator install matt --opencode --json
operator install matt --claude --json
operator install matt --opencode --claude --json
operator ready --json
```

Use `bun cli.ts` in place of `operator` from a source checkout.
An explicit Matt install permits the upstream tool's replacement policy.
It can replace local edits without an Operator preview.
Operator invokes `bun x --bun skills@1.7.4` with a resolved full Matt repository commit, global scope, explicit hosts, and every upstream skill name except names owned by the running Operator release.
The upstream tool owns its shared copies, host links, and lock record, including on Nix devices.
Operator has no upstream plan/apply commands or second upstream-content ledger.
Failed or interrupted installs can have partial effects, so inspect their destinations before another install.
An unconfirmed installer answer exits with code 5.

`ready` checks `gh`, GitHub authentication for `github.com`, `herdr`, and the executable for `superAgent.host` in device settings.
It follows links and compares complete owned contents with the running release.
Required upstream `code-review` must have a nonempty `SKILL.md` in the expected personal location.
OpenCode uses the upstream shared `~/.agents/skills/`, while Claude Code uses `~/.claude/skills/`.
Independent upstream revisions need not match Operator.
Missing prerequisites return current blockers and exit 3, while a ready result exits 0.
The command writes no readiness record, changes no project, and launches no host, metadata handshake, or live probe.
It requires no Slack MCP tools on either host.
Static readiness is not proof of host loading or provider access.
See `docs/implementation/243-static-readiness.md` for ownership, the decision diagram, and verification limits.

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
Effort names come from the selected host and model's current metadata.
This includes custom OpenCode variant names, rather than only a fixed effort list.
Planning and apply validate every complete selection against current host metadata.
Incomplete host-only or effort-only settings can be saved before a model is selected.
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

## Hosts and start profiles

Read the selected host's available models and efforts before choosing them:

```sh
operator host models --host opencode --json
operator host models --host claude-code --json
operator config plan --set superAgent.host=opencode --set superAgent.model=<advertised-model> --json
operator config apply --set superAgent.host=opencode --set superAgent.model=<advertised-model> --plan <plan-id> --json
operator config resolve --role superAgent --json
operator config resolve --json
operator config plan --set profiles.investigation.reasoningEffort=high --json
operator config apply --set profiles.investigation.reasoningEffort=high --plan <plan-id> --json
operator config resolve --profile investigation --json
```

Use `bun cli.ts` instead of `operator` from a source checkout.
Model identifiers in examples are placeholders, not availability claims.
An unset host or model refuses resolution rather than selecting a fallback.
The SuperAgent defaults to high effort.
WorkerAgents inherit the SuperAgent's host and model, with medium effort.
Worker defaults override those fields individually, then a named profile overrides them, then explicit `config resolve` flags override them.
The flags are `--host`, `--model`, and `--effort`.

Profile names use a lowercase letter followed by up to 63 lowercase letters, digits, or hyphens.
`constructor` and `prototype` are reserved.
Use `profiles.<name>.host`, `.model`, or `.reasoningEffort` with the same protected settings commands.
Use `--unset profiles.<name>.<field>` to restore inheritance, or `--unset profiles.<name>` to remove the profile.
Profiles describe launch choices, not a closed list of worker tasks.

OpenCode V2 supplies a directory-scoped model catalog and variant names.
Claude Code supplies supported models and effort levels through its metadata initialization handshake.
That handshake sends no prompt or generation request and does not save a conversation.
Neither metadata path is a readiness probe or proof that a provider request will succeed.
Missing or malformed metadata and unsupported choices refuse without substitution.
Claude aliases with an advertised concrete model resolve to that model, and the result retains the requested name.
`default` and the multi-model `opusplan` mode are not launch selections.

Resolution returns a value and its host command arguments, not a launched worker.
Later settings edits change later resolutions but cannot change an earlier returned value or a running worker.
Dispatch and durable release and skill launch snapshots remain #247.
Operator adds no host permission rules, allow lists, permission modes, or fallback flags.
Host configuration remains under its external owner's control.
See `docs/implementation/241-host-profiles.md` for the selection diagram and verification limits.

## Project registration

Run from the main checkout or one of its subdirectories:

```sh
operator project register --json
operator project register --repository owner/repository --json
operator project show --json
```

For a source checkout, use `bun cli.ts` in place of `operator`.
Registration records one lowercase GitHub identity and real controlling-checkout path.
Several distinct GitHub remote identities require an explicit matching `--repository` choice.
Remote names have no special authority.
Repeating registration from the same controller returns the original record.
An alternate clone refuses and names the controller.
Bare repositories, linked controlling worktrees, and legacy `.operator` entries refuse without modification.

Explicit registration atomically creates `$XDG_STATE_HOME/operator/operator.sqlite` when needed.
It uses the same home fallback as settings state and creates the project's directory in device state.
It changes no checkout files.
`project show` resolves the current controller without creating missing state.
Existing database history must match the running installation's shipped Drizzle migrations.
Damaged or incompatible state is not repaired or replaced.
Automatic upgrades remain #245, and listing, move, and removal remain #246.
See `docs/implementation/240-project-registration.md` for the state diagram, refusals, and test rules.

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
