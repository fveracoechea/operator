# deep-modules/module-imports

Import another feature through its declared public entry. Implementation files belong to their nearest production behavior folder.

Within one owner, private imports are valid. Parents can import direct child entries.
Siblings can import each other's entries. Outside callers cannot import a nested child's entry.
Children cannot import ancestor interfaces or implementations. They can import declared ancestor schema entries.
Declared schema and framework entries are public contracts at the top level, and private entries when nested.
Library dependencies have a separate owner, `deep-modules/lib-imports`, and do not produce duplicate privacy findings.

## Configuration and discovery

Use the shared `settings["deep-modules"]` contract described in the package README.
Every folder containing production TypeScript or TSX, and its intermediate behavior folders, declares ownership.
Discovery does not require an existing entry. Tests and declarations do not create owners.
Configure resource, test-support and generated folders in `exclusions`; they are not inferred from favored folder names.
Filesystem directory aliases are not traversed.

Relative paths, absolute paths, configured prefix aliases, and `package-name/project/path` self references share one resolver.
Alias keys match whole prefixes, not arbitrary substrings. Targets resolve against `projectRoot`.
Package identity comes from the consumer's `projectRoot/package.json`.
Explicit `.ts` and `.tsx`, omitted extensions, and `.js`/`.jsx` source counterparts resolve consistently.
Resolution does not invent `index.ts` access or follow re-export chains.
Package export-map aliases need an explicit configured alias for this release.
Missing targets retain their lexical ownership, so deleting a target cannot turn an illegal private import into approval.

## Syntax and limits

The rule checks imports, side effects, type imports, import types, named and star re-exports, and literal dynamic imports.
It checks unshadowed CommonJS `require`, `require.resolve`, `module.require`, and TypeScript import-equals.
Immutable loader aliases and loaders created by imported `createRequire` from `node:module` or `module` are supported.
Local functions or parameters named `require`, `module`, or `createRequire` are not Node bindings.
Binding cycles terminate rather than following aliases forever.

Runtime-computed strings, template strings, mutable loader aliases, and opaque loader factories are analysis limits.
Passing lint does not certify targets that static syntax cannot resolve.
Oxlint's existing `import/no-cycle` remains responsible for dependency cycles.
