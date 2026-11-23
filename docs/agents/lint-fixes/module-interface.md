# Application interface findings

`deep-modules/module-interface` owns application export shape.
Read the [package-owned guidance](../../../packages/deep-modules/docs/module-interface.md).
Operator builds and loads the same JavaScript entry that the tarball exports.

`bun run lint:modules` runs the shared filesystem checker.
For missing entries, entry tests or misplaced files, read `packages/deep-modules/docs/structure.md`.
Dependency cycles remain with `import/no-cycle`.
