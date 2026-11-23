# Deep-module Oxlint plugin

This package checks application interfaces, nested privacy, library dependencies, collaborator mocks, shared query/mutation ownership and synchronous selectors.
It ships ESM JavaScript and declarations. Consumer loading needs no TypeScript runner or Operator checkout.

## Install and enable

Install this package, `oxlint@1.93.0` and `@oxlint/plugins@1.93.0` as development dependencies.
These exact host versions are the supported compatibility pair.
Node 22.18+ or 24.11+ and Bun can load the plugin.
The Node minimum follows the shipped Babel parser used for local selector dependencies.
Bun is used to develop and pack this repository, not to load the installed JavaScript.

Use the shipped recommended configuration:

```json
{
  "extends": ["./node_modules/@fveracoechea/oxlint-plugin-deep-modules/recommended.json"]
}
```

Or enable individual rules:

```json
{
  "jsPlugins": [
    { "name": "deep-modules", "specifier": "@fveracoechea/oxlint-plugin-deep-modules" }
  ],
  "rules": {
    "deep-modules/module-interface": "error",
    "deep-modules/module-imports": "error",
    "deep-modules/lib-imports": "error",
    "deep-modules/public-collaborator-mocks": "error",
    "deep-modules/query-options-owner": "error",
    "deep-modules/synchronous-selectors": "error"
  }
}
```

Run `oxlint` from the consumer project root.
Run `deep-modules-structure` from that root too. Neither command replaces the other.
The recommended configuration enables these rules.
See [mock guidance](docs/public-collaborator-mocks.md) for Bun binding support, test scope and isolation.
Query ownership does not prove runtime invalidation correctness.
Filesystem structure uses the companion command described below.
Selector checks reject explicit async syntax, not IO, mutation or hidden promises.

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
      "toolingRoots": ["tools", "packages"],
      "allowedFiles": [],
      "aliases": { "@": "src" },
      "objectEntries": ["main.ts", "main.server.ts", "main.tsx", "main.server.tsx"],
      "schemaEntries": ["schemas.ts", "schemas.generated.ts"],
      "frameworkEntries": ["$functions.ts"],
      "selectorSubmodules": ["selectors"],
      "exclusions": ["src/modules/movie/assets", "src/modules/generated"],
      "environmentEntries": [],
      "testScopes": {}
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
Import rules share ownership discovery and static resolution.
Aliases are whole-prefix mappings. Package-self references use the consumer package name and project-relative source paths.

See the [interface](docs/module-interface.md), [privacy](docs/module-imports.md), and [library](docs/lib-imports.md) topics.
See [query ownership](docs/query-options-owner.md) when exposing query and mutation options together.
See [synchronous selectors](docs/synchronous-selectors.md) for declared selector sub-modules and exposed `selector` groups.
Each finding links to its shipped topic.

## Check filesystem structure

Run `deep-modules-structure` from the consumer root after installing the package.
For example, add `"check:modules": "deep-modules-structure"` to your package scripts.
The command runs under the package's supported Node versions and Bun without a TypeScript loader.
It reads the same `.oxlintrc.json` settings as the plugin.
Use `deep-modules-structure --config path/to/config.json` for another JSON configuration.
Relative and package-resolved JSON `extends` are supported.
Settings belong at the top level, not in per-file overrides.

The command owns missing entries, corresponding entry beside-tests and production-file placement.
It does not parse source or repeat syntax, imports or cycles.
Exit codes are 0 for clean structure, 1 for findings and 2 for invalid configuration or command usage.
Diagnostics are sorted by project-relative path and link to the installed [structure guidance](docs/structure.md).

## Policy ownership and limits

| Owner                                    | Checks                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| `deep-modules/module-interface`          | Existing application object entries, constants and callable exports     |
| `deep-modules/module-imports`            | Project import privacy, including root test and configuration consumers |
| `deep-modules/lib-imports`               | Project application and tooling dependencies from libraries             |
| `deep-modules/public-collaborator-mocks` | Bun collaborator replacements in test scope                             |
| `deep-modules/query-options-owner`       | Statically traceable exposed query/mutation ownership                   |
| `deep-modules/synchronous-selectors`     | Explicit asynchronous selector contracts and implementations            |
| `deep-modules-structure`                 | Missing entries, corresponding entry tests and production placement     |

Dependency cycles stay with the host's `import/no-cycle`, not this package.
Oxlint 1.93.0 custom JavaScript plugins do not receive type-aware custom-rule analysis.
Computed imports, opaque provenance and hidden dependency behavior remain analysis limits.
Passing these checks does not prove purity, cache invalidation correctness or sufficient behavior coverage.

## Local package development

From the repository root, run `bun run build:deep-modules`.
Run `bun run test packages/deep-modules/src/module-interface.test.ts` for real-command interface probes.
Use `bun run mutate --plan packages/deep-modules/src/module-interface.ts` to inspect its mutation ownership.
Run `bun pm pack` from this package directory to create a local tarball.
Packing builds JavaScript and declarations; it does not publish anything.

Run `bun run test packages/deep-modules/src/index.installed.test.ts` from the repository root for packed acceptance.
Put a supported `node` executable on `PATH` alongside Bun.
The test installs default and alternate consumers without workspace links.
It checks complete Movie composition, Media promotion, all six rules, structure and restored-clean projects.
Independent review and final qualification remain separate from this test and earlier guidance evaluations.

Operator's existing `bun run test src/modules/operator-release` checks the unchanged CLI delivery contract.
The development package does not belong in that runtime artifact.
