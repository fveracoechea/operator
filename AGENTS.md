## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, driven via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Production modules

Features and capabilities live in flat `src/modules/<feature-or-capability>/` directories.
Each module exports one named PascalCase interface object from `main.ts`.
Import another module only through its `main.ts`; implementation files are private.
Run `bun run lint` for application interface syntax, import privacy and library isolation.
Run `bun run lint:modules` for filesystem structure.
For missing entries, entry tests or misplaced files, read `packages/deep-modules/docs/structure.md`.
For `deep-modules/module-interface`, read `packages/deep-modules/docs/module-interface.md`.
For `deep-modules/module-imports` or `deep-modules/lib-imports`, read the matching topic in `packages/deep-modules/docs/`.
For `deep-modules/query-options-owner`, read `packages/deep-modules/docs/query-options-owner.md`.
For `deep-modules/synchronous-selectors`, read `packages/deep-modules/docs/synchronous-selectors.md`.
Oxlint owns dependency cycles through `bun run lint`.
Small reusable functions that own no feature or capability live in focused `src/lib/` files with beside-tests.
Import their named exports directly, without a barrel or interface object.
Lib code imports no application modules or tooling.
Keep single-use details with their module.

### Bundled skills

`skills/` holds the Operator-owned skills that ship with a release.
Development skills are globally installed, not linked into the checkout.
For custom lint failures, read the named topic under `docs/agents/lint-fixes/`.
For tests and mutation checks, read `docs/agents/testing/writing-tests.md` and `docs/agents/testing/mutation-testing.md`.

### Global agent instructions

Edit Francisco's global agent instructions in `agents/AGENTS.md`.
The dotfiles link that file into each agent host, so this repository is its one home.

## Legacy state

Do not inspect, migrate, repair, or remove real legacy Operator state.
