# deep-modules/structure

The structure command discovers production TypeScript and TSX behavior folders recursively.
Each behavior folder needs an entry.
Run syntax and import rules separately with Oxlint.

## Missing entries

Add a configured object or framework entry to each behavior folder, including nested folders.
Discovery includes folders whose entries do not exist yet and intermediate folders with behavior below them.
Schema-only folders can use their declared schema entry without an object entry.
Server-function modules can use their declared framework entry without a redundant object entry.
Declaring a framework entry does not exempt its module from import privacy.
The command does not inspect entry syntax.

Library roots take precedence over module roots.
Declaration files and test-only folders do not create behavior owners.
Exclude resource and generated trees explicitly through `settings["deep-modules"].exclusions`.
An exclusion names a file or directory, not a glob.
Generated filenames alone do not exempt behavior.

## Missing entry tests

Each existing object or framework entry requires a corresponding behavior beside-test.
For `main.ts`, use `main.test.ts` or `main.<scenario>.test.ts`.
For `main.server.ts`, use `main.server.test.ts` or `main.server.<scenario>.test.ts`.
TSX entries use the same convention with `.tsx`.
The longest existing production stem owns a scenario test.
A server entry test does not cover a separate client entry.
Schema entries do not require behavior tests.

Call the public entry and assert its observable behavior.
An empty file or a test that only checks an export exists does not test the interface.
The command checks test placement, not assertion quality.

## Misplaced production files

Production TypeScript and TSX must belong to a behavior owner, configured library root or configured tooling root.
Module-root files need a feature folder.
Defaults classify `tools/` and `packages/` as tooling.
Configure `toolingRoots` for different tooling locations and `allowedFiles` for explicit entry files such as `src/cli.ts`.
Tests, declarations and `.config.ts` files are legal outside modules.
The placement walk skips hidden directories and `node_modules`.
Exclude other build-output trees explicitly.

## Configuration and failures

Run `deep-modules-structure` from the project root.
It reads `.oxlintrc.json`, including JSON `extends`, or the file selected by `--config`.
All checks share the plugin's validated top-level `settings["deep-modules"]` contract.
Paths resolve against the configured project root.
Exit 0 means clean structure, exit 1 means findings, and exit 2 means invalid usage, configuration or filesystem access.
