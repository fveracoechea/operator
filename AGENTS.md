## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, driven via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Production modules

Features and capabilities live in flat root `modules/<feature-or-capability>/` directories.
Each module exports one named PascalCase interface object from `main.ts`.
Import another module only through its `main.ts`; implementation files are private.
Run `bun run lint:modules` to enforce module shape and boundaries.
Oxlint owns dependency cycles through `bun run lint`.
Small reusable functions that own no feature or capability live in focused root `lib/` files with beside-tests.
Import their named exports directly, without a barrel or interface object.
Lib code imports no application modules or tooling.
Keep single-use details with their module.

### Bundled skills

`skills/` holds the Operator-owned skills that ship with a release.
`.agents/skills/` holds development skills and links to bundled skills; `.claude/skills/` links to the same homes. Only bundled skills are installed elsewhere.

### Global agent instructions

Edit Francisco's global agent instructions in `agents/AGENTS.md`.
The dotfiles link that file into each agent host, so this repository is its one home.

## Breaking workflow replacement

The legacy CLI workflows are removed under #235 before their device-level replacements land.
Help, version reporting, global installation, the Nix package, device settings, launch selection, project registration, skill installation, static readiness, supplied assignment plans, next actions, worker dispatch, the global Herdr plugin, the PR feedback loop with parent-merge relay, report assignments, the guarded merge with cleanup, and the core review request and posting path are available.
For concurrent quality runs, the test watchdog, and open Bun defects, read `docs/implementation/220-concurrent-quality.md`.
For global JSR and source installation, the launcher, and global command discovery, read `docs/implementation/256-global-installation.md`.
For the Nix flake, its launcher, its checks, and `nix/bun.nix` refreshes, read `docs/implementation/257-nix-package.md`.
For review requests, reviewer launch, draft validation, and the guarded review post, read `docs/implementation/253-review-requests.md`.
For PR association, the owner wait loop, and owner attention, read `docs/implementation/249-pr-feedback.md`.
For stacked PR starts, the parent-merge relay, and relay blockers, read `docs/implementation/250-pr-relay.md`.
For report submission, return, acceptance, and cleanup, read `docs/implementation/248-report-assignments.md`.
For the guarded merge, merge verification, ordered cleanup, and unlanded work, read `docs/implementation/251-merge-cleanup.md`.
For dispatch, launch snapshots, worktree preparation, and the live Herdr evidence, read `docs/implementation/247-dispatch.md`.
For startup compatibility, migration blockers, and verified backups, read `docs/implementation/245-automatic-compatibility.md`.
For project listing, controller moves, removal authority, and durable file cleanup, read `docs/implementation/246-project-management.md`.
For source registration, dependencies, and read-only next actions, read `docs/implementation/244-assignment-plans.md`.
For upstream installation, readiness blockers, and evidence limits, read `docs/implementation/243-static-readiness.md`.
For owned copies, conflict rules, and check-only links, read `docs/implementation/242-owned-skills.md`.
For host metadata, profile inheritance, and resolved launch values, read `docs/implementation/241-host-profiles.md`.
For project registration, lookup, database creation, and isolated Git tests, read `docs/implementation/240-project-registration.md`.
For settings edits, environment values, and isolated test roots, read `docs/implementation/239-device-settings.md`.
Read `docs/implementation/235-legacy-removal.md` for the inventory and verification.
Do not inspect, migrate, repair, or remove real legacy Operator state.
