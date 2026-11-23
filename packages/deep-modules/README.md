# Deep-module Oxlint plugin

This package checks application interface exports with `deep-modules/module-interface`.
It ships ESM JavaScript and declarations. Consumer loading needs no TypeScript runner or Operator checkout.

## Install and enable

Install this package, `oxlint@1.93.0` and `@oxlint/plugins@1.93.0` as development dependencies.
These exact host versions are the supported compatibility pair.
Node 22 or later and Bun can load the plugin.
Bun is used to develop and pack this repository, not to load the installed JavaScript.

Use the shipped recommended configuration:

```json
{
  "extends": ["./node_modules/@fveracoechea/oxlint-plugin-deep-modules/recommended.json"]
}
```

Or enable the individual rule:

```json
{
  "jsPlugins": [
    { "name": "deep-modules", "specifier": "@fveracoechea/oxlint-plugin-deep-modules" }
  ],
  "rules": { "deep-modules/module-interface": "error" }
}
```

Run `oxlint` from the consumer project root.
The recommended configuration currently enables only `module-interface`.
Import privacy, mocks, specialized rules and filesystem structure checks are not part of this version.

## Consumer configuration

All portable checks use one validated `settings["deep-modules"]` contract.
Unknown keys, invalid values and invalid entry names fail visibly, even on files outside module roots.
The public `normalizeProjectConfig(settings, cwd)` export at the `./configuration` entry normalizes the same contract.
It returns absolute roots, exclusions and alias targets.

```json
{
  "settings": {
    "deep-modules": {
      "projectRoot": ".",
      "applicationRoots": ["src"],
      "moduleRoots": ["src/modules"],
      "libraryRoots": ["src/lib"],
      "aliases": { "@": "src" },
      "objectEntries": ["main.ts", "main.server.ts", "main.tsx", "main.server.tsx"],
      "schemaEntries": ["schemas.ts", "schemas.generated.ts"],
      "frameworkEntries": ["$functions.ts"],
      "exclusions": ["src/modules/movie/assets", "src/modules/generated"]
    }
  }
}
```

These are the defaults except that aliases and exclusions default to empty collections.
`projectRoot` resolves against the consumer command's working directory.
Other paths resolve against `projectRoot`, never against the plugin installation.
Entry conventions are exact basenames, not paths.
Exclusions name exact files or directory trees, not glob expressions.
Library roots and exclusions take precedence over module roots.
The interface rule checks direct children of module roots only.
Internal entry exports, schemas and framework entries remain unchanged.
Application roots and aliases are normalized for shared consumers; this export-shape rule does not resolve imports.

See [module-interface guidance](docs/module-interface.md) for accepted code and static-analysis limits.
Each finding links to this file in the installed package.

## Local package development

From the repository root, run `bun run build:deep-modules`.
Run `bun run test packages/deep-modules/src/module-interface.test.ts` for real-command interface probes.
Use `bun run mutate --plan packages/deep-modules/src/module-interface.ts` to inspect its mutation ownership.
Run `bun pm pack` from this package directory to create a local tarball.
Packing builds JavaScript and declarations; it does not publish anything.
