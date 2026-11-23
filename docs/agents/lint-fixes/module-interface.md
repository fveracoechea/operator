# Application interface findings

`deep-modules/module-interface` owns application export shape.
Read the [package-owned guidance](../../../packages/deep-modules/docs/module-interface.md).
Operator builds and loads the same JavaScript entry that the tarball exports.

`bun run lint:modules` still checks existing import and filesystem policy.
Dependency cycles remain with `import/no-cycle`.
