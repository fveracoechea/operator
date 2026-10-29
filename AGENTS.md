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

## Legacy state

Do not inspect, migrate, repair, or remove real legacy Operator state.
