## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, driven via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Production modules

Production code lives in flat `modules/<feature-or-capability>/` directories.
Each module exports one named PascalCase interface object from `main.ts`.
Import another module only through its `main.ts`; implementation files are private.
Run `bun run lint:modules` to enforce module shape, boundaries, and dependency cycles.

### Bundled skills

`skills/` holds the Operator-owned skills that ship with a release and that `operator install` copies into a project.
`.agents/skills/` holds development skills and links to bundled skills; `.claude/skills/` links to the same homes. Only bundled skills are installed elsewhere.

<!-- operator:instructions -->
## Operator

This project is coordinated with Operator.
Load the `operator` skill before you delegate work, change the crew configuration, or run a setup operation.
Operator configuration lives in `.operator/config.json`, which is local to this checkout and is not committed.
<!-- /operator:instructions -->
