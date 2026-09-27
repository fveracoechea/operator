# @fveracoechea/operator

## 0.4.0

### Minor Changes

- d94e6c3: Let projects set Operative reasoning effort and change Operator configuration through approved CLI plans.

### Patch Changes

- 95f554c: Use an absolute worktree path for partial results and recognize the returned shell in live readiness probes.
  Give each probe run a distinct fixture amendment section so reruns do not conflict.
- 6061af2: Catch unsafe type assertions, copied reducer accumulators, conditional empty-object spreads, and high-complexity functions during lint.

## 0.3.0

### Minor Changes

- f89ce93: Ship an Operative skill for production and rework assignments.
  Add an approved CLI plan to install and update Matt Pocock skills from a pinned upstream commit.
  Pass the selected model to Herdr when launching crew agents and live probes.
- 9a8944b: Resume Operator after crew changes through a one-shot Herdr wake binding.
  Keep new Operative worktrees in the Operator pane's Herdr workspace.
  Ship the Herdr plugin with the release artifact.

## 0.2.0

### Minor Changes

- 6de2ec8: Ship six more skills: `adr`, `bun`, `deep-modules`, `react-best-practices`, `react-composition`, and `tanstack-tools`.

  `operator setup` copies them into a project beside the skills Operator already ships.
  `adr` records and maintains architecture decisions in `docs/adr/`, `bun` points an agent at current Bun docs and Bun-native APIs, and `deep-modules` sorts a TypeScript app into one module per feature or capability.
  The three frontend skills carry conventions for React effects, rendering and loading, for component API shape, and for the TanStack libraries.

## 0.1.1

### Patch Changes

- 6b9db67: Keep concurrent GitHub calls in the release test log and locate Bash through the test environment, so quality checks do not fail on a lost log entry or a machine without `/bin/bash`.
- Ship an installation guide and CLI documentation with the JSR release.

## 0.1.0

### Minor Changes

- 90574e6: Update and release one matched Operator version.

  `operator update` selects the exact release a project coordinates with, refuses while work is in flight, verifies a backup before it migrates a recorded format, and installs the CLI code and the owned skills together.
  The release artifact carries runnable ESM, public declarations, the complete owned-skill directories, and the generated configuration schema, so neither delivery path runs a build.

- 8474842: Review a pull request on a design axis beside Standards and Spec.

  The `pr-review` skill asks where the functionality landed, which module owns the use case, and what a caller must now know.
  It runs that pass whether or not `code-review` is available, because `code-review` judges lines and this axis judges placement.
  The rules arrive as `DESIGN.md` inside the installed skill, and the three axes compete for the same caps of three blockers and two nice to haves.
