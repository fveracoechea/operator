---
name: setup-ts-deep-modules
description: Use when setting up or changing TypeScript module-boundary and dependency-cycle checks.
disable-model-invocation: true
---

# Set up TypeScript module checks

Load `deep-modules` for placement and interface rules.
Read the repository's agent instructions before choosing its module root and public entry files.
Preserve an existing convention unless the person approves a change.

## Use the existing owners

Operator uses root `modules/<name>/main.ts` for one named PascalCase interface object.
Other module files are private to their module.
Root `lib/` holds focused reusable functions with named exports and beside-tests.
Lib code imports no application module or tooling and needs no interface object.

`scripts/check-module-shape.ts` owns structural checks.
Oxlint's `import/no-cycle` owns dependency-cycle detection.
Use the separate TypeScript check, with lint `typeCheck` off, as ADR-0018 requires.
Keep exact tool pins and the JSON lint configuration.

## Prove a change through the consumer commands

Run these commands after changing a boundary or its enforcement:

```sh
bun run lint:modules
bun run lint
bun run test:module-boundaries
bun run quality
```

The proof script writes deliberate violations in a disposable checkout copy.
Extend it for each new boundary.
Require valid imports to pass, the intended diagnostic to reject each violation, and the restored copy to pass.
Module-to-lib imports and focused lib exports must remain valid.
Private cross-module imports, lib-to-application imports, and real module and lib cycles must fail.

When applying this skill elsewhere, use that repository's public check commands and isolate all deliberate violations from concurrent checks.
Do not copy Operator's folder or interface rules into another repository without checking its design.
