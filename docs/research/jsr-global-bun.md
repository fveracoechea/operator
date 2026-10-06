# Install Operator globally from JSR with Bun

Research for [Install Operator globally from JSR with Bun, #206][ticket], a ticket of the map [#199][map].
Research date: 2026-10-06.
Scope: one global install of `@fveracoechea/operator` per device, with Bun as the only package manager.
This file does not change Operator code.

In this file, "verified" means that a primary source or a command run in this research shows the fact.
"Unverified" means an inference or a fact that no source or run shows.

## Result

Bun can install the JSR package globally through the JSR npm registry.
The person must map the `@jsr` scope to `https://npm.jsr.io` in the global Bun configuration file. (verified, run 1 and run 2)
Bun 1.4.2 does not accept a `jsr:` specifier. (verified, run 3)

Bun links no `operator` binary.
JSR writes its own `package.json` for the npm tarball, and that file has no `bin` field. (verified, [S3], [S4], run 2)
The CLI file runs from any checkout with `bun <global folder>/node_modules/@fveracoechea/operator/cli.js`. (verified, run 4)
A small launcher script in the Bun bin folder makes `operator` a command. (verified, run 8)

The CLI finds its skills, its Herdr plugin, and its lock data from the location of its own files, not from the working directory. (verified, [R1], [R2], [R3], run 5)

Today Operator refuses a global install.
Readiness reports `install_missing`, and every next action names `bun run operator`, which fails in a project with no `scripts.operator`. (verified, run 6 and run 7)

## Sources and versions

| Id | Source | Version or revision | What it shows |
| --- | --- | --- | --- |
| S1 | [JSR npm compatibility docs](https://jsr.io/docs/npm-compatibility) | Retrieved 2026-10-06 | The `@jsr` scope is served from `https://npm.jsr.io`. The name `jsr:@scope/name` maps to `@jsr/scope__name`. |
| S2 | [Bun bunfig docs](https://bun.com/docs/runtime/bunfig) | Retrieved 2026-10-06 | Global `.bunfig.toml` locations, `install.scopes`, `install.globalDir`, `install.globalBinDir`. |
| S3 | [`jsr-io/jsr` `api/src/npm/types.rs` and `tarball.rs`](https://github.com/jsr-io/jsr/blob/0ab10d5f15c9968f07e46eaa0a434103cb6225e3/api/src/npm/types.rs#L87-L99) | Commit `0ab10d5f15c9968f07e46eaa0a434103cb6225e3`, 2026-10-03 | The generated npm `package.json` has only `name`, `version`, `homepage`, `type`, `dependencies`, `exports`, and `_jsr_revision`. |
| S4 | `https://npm.jsr.io/@jsr/fveracoechea__operator` and its `0.7.0.tgz` | Tarball revision 11 | No version from 0.1.0 to 0.7.0 has `bin`. The tarball `package.json` has no `bin`, `scripts`, or `engines`. `cli.js` has mode `0644`. |
| S5 | [`oven-sh/bun` `PackageManagerOptions.rs`](https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/install/PackageManager/PackageManagerOptions.rs#L319-L410) | Tag `bun-v1.4.2`, commit `744846f844374847c902b5e7fd59b4342a51ef99` | The order Bun uses to choose the global package folder and the global bin folder. |
| S6 | [jsr-io/jsr#157](https://github.com/jsr-io/jsr/issues/157), [#636](https://github.com/jsr-io/jsr/issues/636), [#766](https://github.com/jsr-io/jsr/issues/766) | State on 2026-10-06 | #157 (npx-like run, `bin`) is open. #636 (`bin` stripped) closed as a duplicate of #157. #766 (publish CLIs) is open. |
| S7 | [jsr-io/jsr-npm#46](https://github.com/jsr-io/jsr-npm/issues/46) and `src/bin.ts` | Commit `cd2c923d41151a45954c07600ab4f5a24a317678`, 2026-09-24 | The `jsr` client has no `--global` flag. The issue is open, and `src/bin.ts` has no "global" text. |
| S8 | [oven-sh/bun#11911](https://github.com/oven-sh/bun/issues/11911) | Closed as not planned, 2024-06-16 | Bun does not plan native JSR registry support. |
| R1 | `modules/operator-release/manifest.ts` | This repo at `84ec29b` | `packageRoot` comes from `import.meta.url`. `installationRoot` is the folder above the nearest `node_modules`. Lock data is read there. |
| R2 | `modules/skill-install/assets.ts` | This repo at `84ec29b` | Bundled skills come from `new URL("../../skills/", import.meta.url)`. |
| R3 | `modules/crew-wake/plugin.ts` | This repo at `84ec29b` | The expected Herdr plugin manifest path is `new URL("../../herdr/herdr-plugin.toml", import.meta.url)`. |
| R4 | `modules/release-install/selection.ts`, `inspect.ts`, `worktree.ts`, `main.ts` | This repo at `84ec29b` | The JSR delivery needs a devDependency, `scripts.operator`, and lock data. The command is `bun run operator`. |
| R5 | `modules/operative-dispatch/inputs.ts`, `main.ts`, `plan.ts` | This repo at `84ec29b` | Dispatch copies the running installation's lock, compares it with the worktree `bun.lock`, and writes `bun run operator` into the brief and the allow list. |
| R6 | `modules/operator-release/build.ts` | This repo at `84ec29b` | The release build writes `bin: { operator: "./cli.js" }` into the artifact `package.json`. JSR replaces that file (S3). |

## Environment of the runs

Bun 1.4.2 (`744846f84`) on macOS (Darwin 25.6.0).
On this device, Volta supplies Bun at `/Users/fveracoechea/.volta/tools/image/packages/bun/bin/bun`.
Each run used a wrapper script that sets every Bun location to a scratch folder, so the real device install did not change.

```sh
#!/bin/sh
S=<scratch>/jsr206
export BUN_INSTALL="$S/bunhome"
export BUN_INSTALL_CACHE_DIR="$S/cache"
export XDG_CONFIG_HOME="${ISO_CONFIG:-$S/noconfig}"
unset BUN_INSTALL_GLOBAL_DIR BUN_INSTALL_BIN XDG_CACHE_HOME
cd "$S/work" || exit 1
exec /Users/fveracoechea/.volta/tools/image/packages/bun/bin/bun "$@"
```

`ISO_CONFIG` points at a folder that holds this `.bunfig.toml`:

```toml
[install.scopes]
"@jsr" = "https://npm.jsr.io"
```

## Install

### The registry configuration

Bun reads a global `.bunfig.toml` from `$HOME/.bunfig.toml` or `$XDG_CONFIG_HOME/.bunfig.toml`. [S2] (verified)
Only package manager commands read the global file. [S2] (verified)
Put the `@jsr` scope in that file:

```toml
[install.scopes]
"@jsr" = "https://npm.jsr.io"
```

The key `"@jsr"` with the `@` worked in run 2. (verified)
A project `.npmrc` with `@jsr:registry=https://npm.jsr.io` is the form the JSR docs show. [S1] (verified)
This research did not test if `bun add -g` reads a `.npmrc`. (unverified)

### The install command

Use an npm alias, so that the package folder has the JSR package name:

```sh
bun add -g "@fveracoechea/operator@npm:@jsr/fveracoechea__operator@0.7.0"
```

With the alias, Bun puts the package at `node_modules/@fveracoechea/operator`. (verified, run 5)
Without the alias, Bun puts it at `node_modules/@jsr/fveracoechea__operator`. (verified, run 2)
The CLI runs from both folders, because it finds its files from its own location. (verified, run 4)
The alias keeps one stable folder path for the launcher and the Herdr plugin across updates.

### Run 1. No scope configuration

```text
$ iso.sh add -g @jsr/fveracoechea__operator@0.7.0
bun add v1.4.2 (744846f84)
Resolving dependencies
Resolved, downloaded and extracted [1]
error: GET https://registry.npmjs.org/@jsr%2ffveracoechea__operator - 404
```

### Run 2. With the scope configuration

```text
$ ISO_CONFIG=<scratch>/config iso.sh add -g @jsr/fveracoechea__operator@0.7.0
bun add v1.4.2 (744846f84)
Resolving dependencies
Resolved, downloaded and extracted [12]
Saved lockfile

installed @jsr/fveracoechea__operator@0.7.0

3 packages installed [653.00ms]
```

After run 2, `bunhome/bin` was empty, and `install/global/node_modules/.bin` did not exist.

### Run 3. The `jsr:` specifier

```text
$ ISO_CONFIG=<scratch>/config iso.sh add -g jsr:@fveracoechea/operator@0.7.0
error: InstallFailed cloning repository for jsr:@fveracoechea/operator@0.7.0
error: Invalid dependency name "jsr:@fveracoechea/operator@0.7.0"
error: jsr:@fveracoechea/operator@0.7.0 failed to resolve
```

Bun closed native JSR support as not planned. [S8] (verified)
The `jsr` client (`bunx jsr add`) has no `--global` flag. [S7] (verified)

## Where the files land

Bun chooses the global package folder in this order. [S5] (verified)

1. `BUN_INSTALL_GLOBAL_DIR`.
2. `install.globalDir` in bunfig.
3. `$BUN_INSTALL/install/global`.
4. `$XDG_CACHE_HOME/.bun/install/global`, else `$HOME/.bun/install/global`.

Bun chooses the global bin folder in this order. [S5] (verified)

1. `BUN_INSTALL_BIN`.
2. `install.globalBinDir` in bunfig.
3. `$BUN_INSTALL/bin`.
4. `$XDG_CACHE_HOME/.bun/bin`, else `$HOME/.bun/bin`.

Step 4 uses `XDG_CACHE_HOME`, not `XDG_CONFIG_HOME`. [S5] (verified)
With no variables set, the package folder is `~/.bun/install/global` and the bin folder is `~/.bun/bin`.

The global folder after the alias install held these files. (verified, run 5)

```text
install/global/package.json
install/global/bun.lock
install/global/node_modules/@fveracoechea/operator/   (cli.js, modules/, skills/, herdr/, release.json, ...)
install/global/node_modules/drizzle-orm/
install/global/node_modules/zod/
bin/                                                  (empty)
```

`bun pm bin -g` prints the bin folder, and `bun pm ls -g` lists the global packages. (verified)

```text
$ iso.sh pm ls -g
<scratch>/bunhome/install/global node_modules (3 installed)
└── @fveracoechea/operator@0.6.0
```

## Why Bun links no binary

The Operator release build writes `bin: { operator: "./cli.js" }` into the artifact `package.json`. [R6] (verified)
JSR does not serve that file to npm clients.
JSR writes a new `package.json` with only `name`, `version`, `homepage`, `type`, `dependencies`, `exports`, and `_jsr_revision`. [S3] (verified)
The registry metadata for every published version from 0.1.0 to 0.7.0 has no `bin`. [S4] (verified)
The 0.7.0 tarball `package.json` is this text. [S4] (verified)

```json
{
  "name": "@jsr/fveracoechea__operator",
  "version": "0.7.0",
  "homepage": "https://jsr.io/@fveracoechea/operator",
  "type": "module",
  "dependencies": { "drizzle-orm": "0.44.6", "zod": "4.6.5" },
  "exports": { "./cli": { "default": "./cli.js" } },
  "_jsr_revision": 11
}
```

The generated file also has no `scripts`, so a `postinstall` script cannot make a link. [S3] (verified)
The tarball stores `cli.js` with mode `0644`, so a symlink to it does not run directly. [S4] (verified, run 8)
JSR tracks `bin` support in jsr-io/jsr#157, which is open. [S6] (verified)

## How to run it from any checkout

### Run 4. The CLI file by path

```text
$ cd <scratch>/proj
$ bun <scratch>/bunhome/install/global/node_modules/@fveracoechea/operator/cli.js --version --json
{"schemaVersion":1,"outcome":"completed","reason":"version_reported","blockers":[],"operation":"version","data":{"operatorVersion":"0.7.0","bunVersion":"1.4.2","selection":{"state":"missing"}}}
```

### Run 8. A launcher in the bin folder

A person, or a future Operator command, writes this file to the Bun bin folder and makes it executable:

```sh
#!/bin/sh
exec bun "$HOME/.bun/install/global/node_modules/@fveracoechea/operator/cli.js" "$@"
```

The run used the scratch path in place of `$HOME/.bun`.

```text
$ <scratch>/bunhome/bin/operator --version --json
{"schemaVersion":1,"outcome":"completed","reason":"version_reported","blockers":[],"operation":"version","data":{"operatorVersion":"0.6.0","bunVersion":"1.4.2"}}
```

After `bun add -g` moved the package to 0.7.0, the same launcher ran 0.7.0. (verified)
A symlink from the bin folder to `cli.js` failed with `permission denied`, because `cli.js` has mode `0644`. (verified)
`bun <symlink>` ran, and the CLI read the skills of the real package folder. (verified, the update plan compared the package skills with the project copies)

## How the binary finds its files

The CLI never reads its own files from the working directory.

- `packageRoot` is `new URL("../../", import.meta.url)` from `modules/operator-release/manifest.js`. [R1] (verified)
- The bundled skills come from `new URL("../../skills/", import.meta.url)`. [R2] (verified)
- The expected Herdr plugin manifest is `new URL("../../herdr/herdr-plugin.toml", import.meta.url)`. [R3] (verified)
- `installationRoot` is the folder above the nearest `node_modules` in `packageRoot`. For a global install, this is the Bun global folder. [R1] (verified)
- `readLockData` reads `bun.lock` or `bun.lockb` in `installationRoot`. For a global install, this is the global `bun.lock`. [R1] (verified)

### Run 5. Update plan and apply from the global copy

In an empty Git repository, the global copy planned and applied an update, and found the lock data and 10 bundled skills.

```text
$ bun <global>/node_modules/@fveracoechea/operator/cli.js update plan --claude \
    --commit 2a3ac7b01e540c0cfad1c5da4c00c9db020c3171 --delivery jsr --package-version 0.7.0 --json
outcome: completed, reason: update_plan_ready, blockers: [], skills to install: 10

$ bun <global>/.../cli.js update apply ... --approved-update 499ecba7...d6b5 --json
outcome: completed, reason: update_applied
commands: {"install": "bun install --frozen-lockfile", "run": "bun run operator <operation>", ...}

$ ls .claude/skills
adr bun deep-modules no-slop operative operator pr-review react-best-practices react-composition tanstack-tools
```

## Update and version pin

| Action | Command | Result | Status |
| --- | --- | --- | --- |
| Install an exact version | `bun add -g "@fveracoechea/operator@npm:@jsr/fveracoechea__operator@0.6.0"` | `package.json` records `npm:@jsr/fveracoechea__operator@0.6.0`. | verified |
| Update within the recorded range | `bun update -g` | "Checked 3 installs across 4 packages (no changes)". The exact pin stays at 0.6.0. | verified |
| Update to the newest version | `bun update -g --latest` | "@fveracoechea/operator 0.6.0 -> 0.7.0". The record changes to `...@0.7.0`. | verified |
| Move to one exact version | `bun add -g "@fveracoechea/operator@npm:@jsr/fveracoechea__operator@<version>"` | The package moved back from 0.7.0 to 0.6.0. | verified |
| Install with no version | `bun add -g "@fveracoechea/operator@npm:@jsr/fveracoechea__operator"` | The record became `^0.6.0`, and the package stayed at 0.6.0 while 0.7.0 was the latest. | verified |

Always give an exact version.
A caret range on a `0.x` version permits only patch changes under semver, so `^0.6.0` never reaches 0.7.0. (unverified for Bun specifically, the run only shows that 0.6.0 stayed)

The global folder has one `node_modules`, so one device runs one Operator version for every checkout. (verified from the layout)

## What breaks today

1. Readiness refuses the global install. (verified, run 6)

   ```text
   install_missing: The project must declare @fveracoechea/operator as the exact JSR devDependency
   npm:@jsr/fveracoechea__operator@0.7.0 and set scripts.operator to bun node_modules/@fveracoechea/operator/cli.js.
   ```

   `checkJsrInstall` in `modules/release-install/inspect.ts` also reads `node_modules/@fveracoechea/operator/package.json` in the project and requires project lock data. [R4] (verified)

2. The command `bun run operator` fails in a project with no `scripts.operator`. (verified, run 7)

   ```text
   $ bun run operator --version
   error: Script not found "operator"
   exit=1
   ```

   `ReleaseInstall.invocation` returns `bun run operator` for the JSR delivery. [R4] (verified)
   After `update apply`, `--version --json` reports `"invocation":"bun run operator"`. (verified, run 8)
   The next action of each readiness blocker names `bun run operator`. (verified, run 6)
   17 files of the bundled `operator` skill name `bun run operator`. (verified, `grep -rl`)

3. Dispatch refuses a worktree without the project installation. [R5] (verified by reading the code, not run)

   `checkWorktreeInstallation` needs the devDependency, `scripts.operator`, a committed `bun.lock`, and a lock that pins `@jsr/fveracoechea__operator` at the selected version.
   Dispatch copies the running installation's lock into `.operator/local/` and requires the worktree `bun.lock` to have the same bytes.
   For a global install, the running lock is the global `bun.lock`, so the bytes never match a project lock.

4. The Operative brief and the Claude Code allow list name the project command. [R5] (verified by reading the code)

   The allow list has `Bash(bun run operator attempt acknowledge:*)` and `Bash(bun install --frozen-lockfile)`.
   The brief tells the Operative to run `bun install --frozen-lockfile` first.

5. `ReleaseInstall.commands` reports `bun install --frozen-lockfile` and `bunx --bun jsr add --bun --save-dev` for the JSR delivery. [R4] (verified, run 5)

## Open risks

- The global `bun.lock` covers every global Bun package on the device. Its identity changes when the person installs or updates any other global package. Readiness fingerprints and the dispatch drift check both use the lock identity. (unverified effect, the code reads the identity [R1], [R5])
- One device holds one version, but each project records its own selection. Two projects that select different versions cannot both run on one device. (unverified, inference from the layout)
- Bun links no binary until JSR supports `bin` (jsr-io/jsr#157). Somebody must write the launcher. (verified)
- On this device Volta supplies Bun, and the agent shell `PATH` has `~/.volta/bin` but not `~/.bun/bin`. A launcher in `~/.bun/bin` needs that folder on `PATH`. The interactive shell `PATH` was not checked. (unverified for the interactive shell)
- The Herdr plugin path check compares the enabled plugin with the package path. The alias install keeps one stable path across updates. A move from a project install to a global install changes the path, so the person must link the plugin again. (unverified, inference from [R3])
- The runs used macOS only. Linux and Windows were not tested. (unverified)
- This research did not test `bunx` with the JSR scope. With no `bin`, `bunx` has no command to run. (unverified)

[ticket]: https://github.com/fveracoechea/operator/issues/206
[map]: https://github.com/fveracoechea/operator/issues/199
