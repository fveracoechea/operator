# Package the Bun CLI and its skills as a Nix flake

Resolves [Package the Bun CLI and its skills as a Nix flake](https://github.com/fveracoechea/operator/issues/205) on the map [Map the global Operator home and the source reset](https://github.com/fveracoechea/operator/issues/199).
This is research only.
It changes no Operator code.

## Scope and method

Report date 2026-10-06.
Each fact has a mark.
**Verified** means a primary source says it, or a probe on this machine showed it.
**Unverified** means no source or probe proved it.

Sources:

- The Nix 2.34.8 manual pages `nix3-flake` and `nix3-flake-check`, read on this machine.
- The nixpkgs source at `aa48d347080940b8a2b8d2f48228674e280a3514` (version 26.11, `nixpkgs-unstable`), and the `nixos-26.05` source. Both are the revisions that `~/dotfiles/flake.lock` holds.
- The bun2nix source and docs at `c843f477b15f51151f8c6bcc886954699440a6e1` (2.0.8, the revision in `~/dotfiles/flake.lock`), and the bun2nix 2.1.0 to 2.1.2 release notes and `nix/mk-derivation/hook.nix` on `main` through the GitHub API.
- The hunk flake at `252f59dd39409b2390d02b0f9e003819c9d41176` (`flake.nix`, `nix/package.nix`, `nix/README.md`, `.github/workflows/nix.yml`).
- The Home Manager source that `~/dotfiles/flake.lock` holds (`modules/programs/claude-code/`, `modules/programs/opencode.nix`).
- The Bun docs page for `bunfig.toml` and `bun --help` of Bun 1.4.2.
- The GitHub docs page for hosted runners, and the `cachix/install-nix-action` README.
- This repository at `84ec29b` and at the tag `v0.7.0` (`2a3ac7b`), and the published JSR record `https://jsr.io/@fveracoechea/operator/0.7.0/release.json`.

Probes ran on `aarch64-darwin` with Nix 2.34.8 (`sandbox = false` in this machine's configuration) and Bun 1.4.2.
The prototype flake is in the appendix.
No probe ran on `x86_64-linux`.

## What the release artifact holds

All facts in this section are **verified** from the source.

- `package.json` names `bin.operator = ./cli.ts`, `engines.bun = ">=1.4.0"`, and `packageManager = "bun@1.4.2"`. Runtime dependencies are `drizzle-orm@0.44.6` and `zod@4.6.5`. All other packages are development dependencies.
- `bun.lock` is the text lock (`lockfileVersion: 1`, `configVersion: 1`) with 96 package entries. These include native bindings of `oxfmt` and `oxlint` for every platform.
- `cli.ts` starts with `#!/usr/bin/env bun` and calls `OperatorCli.main(Bun.argv.slice(2))`.
- `modules/operator-cli/run.ts` refuses to start when `Bun.semver.satisfies(Bun.version, supportedBun)` is false. `supportedBun` comes from `release.json`, else from `engines.bun`.
- `bun scripts/release.ts build --out <dir> --commit <sha>` runs `OperatorRelease.build` (`modules/operator-release/build.ts`). It transpiles each `.ts` file that `cli.ts` reaches to `.js` with `Bun.Transpiler`, writes declarations with `bunx --bun --no-install tsc`, copies `skills/` and `herdr/`, and writes `config.schema.json`, `gate.schema.json`, `README.md`, `package.json`, and `jsr.json`.
- The build needs the development dependencies, because it runs `tsc` and reads `node_modules/@types`.
- After the build writes all other files, it writes `release.json` with `version`, `commit`, `supportedBun`, `builtAt`, and `artifactIdentity`.
- `artifactIdentity` is a SHA-256 over the path and the bytes of every file in the artifact except `release.json` (`modules/operator-release/inventory.ts`).
- `builtAt` is `request.now ?? new Date().toISOString()`, and `scripts/release.ts` passes no `now`. So `release.json` changes on each build.
- The release identity that `OperatorRelease.identify()` reports is a SHA-256 of `version` and the skills identity. The commit comes from `release.json`.
- `readLockData` looks for `bun.lock` in the installation root. That root is the folder above the nearest `node_modules` segment of the package path, or the package root when there is no such segment. `release-install` reports `lock_data_missing` when the running installation has no lock data.
- `skill-install` finds the bundled skills at `new URL("../../skills/", import.meta.url)`, which is `skills/` beside `cli.js`.
- `skills/` holds ten skill folders and a `README.md`.
- The release workflow builds the artifact on `ubuntu-latest` with Bun 1.4.2 and `bun install --frozen-lockfile`, then publishes the tag `v<version>` and the JSR version from that one commit.

## Ways to package a Bun program in Nix

### bun2nix

**Verified** from the bun2nix docs and source.

- The `bun2nix` CLI reads `bun.lock` and writes a Nix file (`bun.nix`) with one `fetchurl` per package. The hash comes from the lock, so no prefetch is necessary.
- `bun2nix.fetchBunDeps { bunNix = ./bun.nix; }` fetches each package and makes a Bun install cache in the store.
- `bun2nix.hook` is a setup hook. It copies that cache to `$BUN_INSTALL_CACHE_DIR` and runs `bun install --ignore-scripts` with `--linker=isolated` (and `--backend=symlink` on `aarch64-darwin`) before the build phase.
- The hook propagates `pkgs.bun` from the nixpkgs that bun2nix receives. This is also true on `main` after 2.1.2.
- The hook has a default patch phase that runs `patchShebangs .` on the source, unless `dontUseBunPatch` is set.
- `bun2nix.mkDerivation` builds a single binary with `bun build --compile --minify --sourcemap --bytecode` by default.
- `bun2nix.writeBunApplication` keeps the source folder and `node_modules`, and runs a start script.
- The CLI ships two ways. The npm package `bun2nix` is a WASM build that runs with `bunx`. The flake package is a native Rust build.
- Release 2.1.2 (2026-07-21) changed the default `systems` input from `nix-systems/default` to `nix-systems/triplet`.

**Verified** by probe.

- `bunx bun2nix@2.1.2 -o nix/bun.nix` read this repository's `bun.lock` and wrote 95 `fetchurl` entries.
- A flake with `bun2nix.hook` and that `bun.nix` built the artifact offline in the Nix build. `bun install` reported 59 packages installed.

### A fixed-output derivation of `node_modules`

**Verified** from nixpkgs source.

- nixpkgs packages `opencode`, `hunk` 0.22.0, `swagger-typescript-api`, and others with a second derivation that runs `bun install --frozen-lockfile` with network access and fixes the result with `outputHash`.
- `swagger-typescript-api` keeps one `outputHash` for each system. `opencode` adds scripts that canonicalize `node_modules`, so that the hash stays stable.
- The hash is not in `bun.lock`. A maintainer must rebuild on each system to learn a new hash after each lock change or Bun change.

### A wrapper of `bun` over the sources

**Verified** from `bun --help`.

- Without `node_modules`, `bun` installs missing packages when it runs (`--install=auto` is the default "when no node_modules").
- The store is read-only, and a run that fetches packages is not reproducible. So a plain wrapper must still get `node_modules` from one of the two ways above.

### nixpkgs has no Bun builder

**Verified** from nixpkgs source.
The nixpkgs manual section `javascript.section.md` does not mention Bun.
`pkgs/build-support` has no Bun builder.
No nixpkgs package uses bun2nix.

### Which way is reproducible from `bun.lock`

Only bun2nix derives every fetch hash from `bun.lock`. (**Verified** from its docs.)
The fixed-output way is reproducible only while its hand-kept hash stays correct.

## Pinned Bun

**Verified** from nixpkgs source.

- nixpkgs 26.11 (`nixpkgs-unstable` at `aa48d34`) has `bun` 1.4.2.
- nixpkgs `nixos-26.05` has `bun` 1.3.13. That Bun fails the `engines.bun >=1.4.0` check at startup.
- A consumer often sets `inputs.operator.inputs.nixpkgs.follows`. Then the consumer's nixpkgs decides `pkgs.bun`, and so the hook's Bun and any runtime Bun from nixpkgs.

**Verified** from the hunk source.
Hunk fetches the official Bun archive `@oven/bun-<platform>@<version>` from the npm registry by `fetchurl` with a fixed hash, and takes the version from `packageManager`.
On Linux it adds `autoPatchelfHook`.
The integrity values for `@oven/bun-darwin-aarch64@1.4.2` and `@oven/bun-linux-x64@1.4.2` in hunk's `nix/package.nix` match the npm registry metadata.

**Verified** by probe.

- The prototype fetched Bun 1.4.2 this way and used it for the build and in the `operator` wrapper.
- When the pinned Bun comes before `bun2nix.hook` in `nativeBuildInputs`, the hook's `bun install` uses the pinned Bun. The probe printed the store path of the pinned Bun from `preBunNodeModulesInstallPhase`.

## `packages.<system>.default` for two systems

**Verified** from the Nix manual.
`nix flake check` requires `packages.<system>.default` and `checks.<system>.<name>` to be derivations, and builds the checks.
By default it checks only the current system.
`--all-systems` checks every system, and `--no-build` only evaluates.

**Verified** by probe.

- A flake with `lib.genAttrs ["aarch64-darwin" "x86_64-linux"]` evaluated on both systems with `nix flake check --all-systems --no-build`.
- `nix flake check` on `aarch64-darwin` built the package and both checks.

**Unverified**, from a comment in the hunk flake.
bun2nix 2.0.8 makes its outputs for every system of its `systems` input.
**Verified** from the hunk source.
Hunk sets `bun2nix.inputs.systems.follows = "systems"` with `nix-systems/triplet`, because nixpkgs 26.11 throws for `x86_64-darwin`.
The prototype did the same.

**Unverified.**
The `x86_64-linux` package did not build, because this machine has no Linux builder.
Its sandbox behaviour and its `autoPatchelfHook` step are not proven.

## A fixed path for the skills

**Verified** from nixpkgs source.
nixpkgs 26.11 has the setup hook `installAgentSkills`.
Its manual section says that it installs skills into `$out/share/skills/($pname|$base)/$skill/`.
Its tests name `hunk`, `worktrunk`, and `gh-stack` as packages that use it.
`nixos-26.05` does not have it.
Its automatic mode installs every folder with a `SKILL.md` under the build folder, which in this repository includes `.agents/skills/`.

**Verified** from the Home Manager source.
`programs.claude-code.skills` and `programs.opencode.skills` accept an attribute set whose values are a path or a path string to a skill folder.
For a path string, Home Manager tests the target with `-d` and links it.
Both options also accept one folder of skill folders.

**Verified** by probe.
The prototype put the skills at `share/skills/operator/<name>`, as a link to the `skills/` folder of the artifact.
`test -f $out/share/skills/operator/no-slop/SKILL.md` passed in a flake check.

The ticket proposed `share/operator/skills/<name>`.
The nixpkgs convention is `share/skills/operator/<name>`.

## Proving `operator --version` on both systems

**Verified** by probe on `aarch64-darwin`.
A check that runs `${operator}/bin/operator --version` in the build sandbox printed `operator 0.7.0` and `Selection: missing. This project selected no release.`, and passed.

**Verified** from the GitHub docs.
`macos-latest`, `macos-14`, `macos-15`, and `macos-26` are arm64 runners.
`ubuntu-latest` is x64.

**Verified** from the `cachix/install-nix-action` README.
It installs Nix on Linux and macOS runners, with the sandbox on by default on Linux.
The latest release is v31.11.1.

**Verified** from the hunk source.
Hunk's CI job runs `nix flake check --print-build-logs`, then `nix flake check --all-systems --no-build`, then `nix build`, then runs `./result/bin/hunk --version`.
It also runs `nix run .#update-bun-lock` and fails when `git diff` shows a changed `nix/bun.lock.nix`.

## The same commit and content identity as the JSR artifact

**Verified** from the Nix manual.
The `self` input has `rev`, `lastModified`, `lastModifiedDate`, and `narHash`.
`revCount` is not available for `github:` inputs.

**Verified** by probe.

- The prototype passed `self.rev or self.dirtyRev or "unknown"` to `release.ts build --commit`. A clean tree recorded the commit hash. A tree with an uncommitted change recorded `<rev>-dirty`.
- With the hook's default patch phase, `cli.js` started with a `/nix/store/...-bun-1.4.2/bin/bun` line, so the artifact bytes changed. With `dontUseBunPatch = true` and `dontFixup = true`, `cli.js` kept `#!/usr/bin/env bun`.
- The Nix build and a plain `bun scripts/release.ts build` of the same tree gave the same `artifactIdentity` (`6bc72d05...`). `diff -r` showed only `builtAt` in `release.json`.
- The prototype flake on the `v0.7.0` tree gave `artifactIdentity` `745a5f43625e933c8bab55afce4f22dbeb64fe9dd25161678050a8302d697038`. The published JSR `0.7.0/release.json` has the same value, and its `commit` `2a3ac7b` is the commit of the tag `v0.7.0`.
- A check that calls `OperatorRelease.inspect` on the installed artifact got the same identity as its `release.json`, and the status `complete`.

**Verified** from nixpkgs source.
`stdenv` exports `SOURCE_DATE_EPOCH` with the fallback `315532800`.
`release.ts` does not read it, so `builtAt` still changes on each build.

## Other probe results

**Verified** by probe.

- A `bunfig.toml` with `preload` in the working folder ran its preload before `operator --version` of the Nix package. `bun --config=<empty file> cli.js --version` did not run it.
- `bun install --frozen-lockfile --production --linker=hoisted --backend=copyfile` on a copy of `package.json` and `bun.lock` installed only the runtime packages as plain files. It also installed `@types/bun`, `bun-types`, and `undici-types`.
- The installed closure is 91 MB. The pinned Bun is the largest part.
- `operator --version` ran in the check with `HOME` set to the build's temporary folder. The sandbox was off, so the probe does not prove that the command needs no network.

## Recommendation

Use bun2nix to install the locked dependencies, and run the same `release.ts build` as the release job inside the Nix build.

1. Commit `nix/bun.nix`, written by a pinned bun2nix CLI from `bun.lock`. Add a check that writes it again and fails on a difference, as hunk does.
2. Fetch Bun from the official archive at the version that `packageManager` names, with one hash for each system. List it before `bun2nix.hook`, and use it in the wrapper. Do not take Bun from the consumer's nixpkgs.
3. Set `dontUseBunPatch`, `dontRunLifecycleScripts`, `dontUseBunBuild`, `dontUseBunCheck`, and `dontFixup`. Run `bun scripts/release.ts build --out dist --commit ${self.rev}`. Refuse a dirty tree in a release build, or let it record `-dirty`.
4. Lay out the output like a JSR installation. Put the artifact at `lib/operator/node_modules/@fveracoechea/operator`, the runtime packages beside it in `lib/operator/node_modules`, and `bun.lock` at `lib/operator/bun.lock`. Then the artifact folder is byte for byte the JSR artifact, and `readLockData` finds lock data.
5. Make `bin/operator` a wrapper that runs the pinned Bun on `cli.js`.
6. Link each skill folder at `share/skills/operator/<name>`. Do not use the `installAgentSkills` hook, and do not link `skills/README.md` as a skill.
7. Expose `packages.aarch64-darwin.default` and `packages.x86_64-linux.default`, and set bun2nix's `systems` input to follow a two-system or triplet list.
8. Add `checks.<system>.version` (runs `operator --version`), `checks.<system>.identity` (recomputes `artifactIdentity` and compares it with `release.json`), and a skill path check.
9. Add a CI job on `ubuntu-latest` and `macos-latest` that runs `nix flake check -L`. In the release workflow, compare the `artifactIdentity` of the Nix build with the one of `dist/release.json` at the same commit.
10. Tell consumers to pin the tag `github:fveracoechea/operator/v<version>`. Then `self.rev` is the commit that the tag and the JSR `release.json` name.

Consumer wiring, for example in `~/dotfiles`:

```nix
operatorPackage = codingAgentSources.operator.packages.${pkgs.stdenv.hostPlatform.system}.default;
home.packages = [operatorPackage];
programs.claude-code.skills.no-slop = "${operatorPackage}/share/skills/operator/no-slop";
```

The dotfiles input must drop `flake = false` for this.

## Rejected options

- **A fixed-output `node_modules`.** Its hash is not in `bun.lock`, so each lock change or Bun change needs a hand rebuild on each system.
- **`bun2nix.mkDerivation` with `bun build --compile`.** The binary is not the JSR artifact, so `artifactIdentity` cannot match. It also moves `import.meta.url` into the binary, and the CLI uses that path to find `release.json` and `skills/`.
- **`bun2nix.writeBunApplication` over the source folder.** It has no `release.json`, so the running release reports no commit and no artifact identity.
- **A plain `bun` wrapper over the sources.** Bun installs missing packages from the network at run time, which the read-only store and reproducibility forbid.
- **Fetching the published JSR tarball by hash.** The flake at commit X cannot hold the hash of an artifact that is built and published from X.
- **Bun from nixpkgs.** A consumer that follows `nixos-26.05` gets Bun 1.3.13, which the CLI refuses, and the version moves with every nixpkgs update.
- **The `installAgentSkills` hook.** `nixos-26.05` does not have it, and its automatic mode also installs `.agents/skills/`. Its folder layout is still the one to use.

## Open risks

- The `x86_64-linux` build is unverified. A CI run on `ubuntu-latest` must prove it in the sandbox.
- `builtAt` makes the output differ on each build, so `nix build --rebuild` reports a difference. A fix is a small `release.ts` change that reads `SOURCE_DATE_EPOCH` or takes a `--built-at` flag. That is code work for an implementation slice.
- A `bunfig.toml` in the project folder changes how the CLI runs, for example by a preload. This is also true of the JSR path. The wrapper can pass `--config` with an empty file, but that is a product decision.
- `bun.lock` in `lib/operator` is the lock of the Operator repository, not of a consumer project. It satisfies `readLockData`, which only checks that lock data is present. Ticket #208 decides what lock data means on a device.
- bun2nix adds `flake-parts`, `treefmt-nix`, `systems`, and its own `nixpkgs` to the consumer's lock. Its cache tool is a Zig build, which a consumer without the `nix-community` cache builds from source.
- The bun2nix hook behaviour is from 2.0.8, with 2.1.2 checked only for the Bun input and the release notes. The flake should pin one release and the CLI version that writes `bun.nix` should match it.
- Each Bun update needs two new archive hashes in the flake. A check that compares the fetched Bun with `packageManager` catches a missed update.
- The release smoke on three delivery paths is still open on the map. The identity check above is one way to prove that the Nix path carries the same artifact.

## Appendix: prototype flake

`flake.nix`:

```nix
{
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/aa48d347080940b8a2b8d2f48228674e280a3514";
    systems.url = "github:nix-systems/triplet/6de7bc09397911ce03636afbcf6118745ab2cda0";
    bun2nix.url = "github:nix-community/bun2nix/c843f477b15f51151f8c6bcc886954699440a6e1";
    bun2nix.inputs.nixpkgs.follows = "nixpkgs";
    bun2nix.inputs.systems.follows = "systems";
  };

  outputs = {self, nixpkgs, bun2nix, ...}: let
    lib = nixpkgs.lib;
    systems = ["aarch64-darwin" "x86_64-linux"];
    forAll = f: lib.genAttrs systems (system: f system nixpkgs.legacyPackages.${system});
    version = (lib.importJSON ./package.json).version;
  in {
    packages = forAll (system: pkgs: {
      default = pkgs.callPackage ./nix/package.nix {
        bun2nix = bun2nix.packages.${system}.default;
        commit = self.rev or self.dirtyRev or "unknown";
      };
    });

    checks = forAll (system: pkgs: let
      operator = self.packages.${system}.default;
    in {
      version = pkgs.runCommand "operator-version-check" {} ''
        export HOME=$TMPDIR
        ${operator}/bin/operator --version | tee $out
        grep -qx "operator ${version}" <(head -n1 $out)
        test -f ${operator}/share/skills/operator/no-slop/SKILL.md
      '';
      identity = pkgs.runCommand "operator-identity-check" {} ''
        export HOME=$TMPDIR
        root=${operator}/lib/operator/node_modules/@fveracoechea/operator
        ${operator.passthru.bun}/bin/bun -e "
          const { OperatorRelease } = await import('$root/modules/operator-release/main.js');
          const inspected = await OperatorRelease.inspect({ artifactRoot: '$root' });
          const recorded = await Bun.file('$root/release.json').json();
          console.log(JSON.stringify({ inspected: inspected.artifactIdentity, recorded: recorded.artifactIdentity }));
          if (inspected.status !== 'complete' || inspected.artifactIdentity !== recorded.artifactIdentity) process.exit(1);
        " | tee $out
      '';
    });
  };
}
```

`nix/package.nix`:

```nix
{lib, stdenv, stdenvNoCC, fetchurl, autoPatchelfHook, makeWrapper, bun2nix, commit}: let
  packageJson = lib.importJSON ../package.json;
  bunVersion = lib.removePrefix "bun@" packageJson.packageManager;
  bunArchives = {
    aarch64-darwin = fetchurl {
      url = "https://registry.npmjs.org/@oven/bun-darwin-aarch64/-/bun-darwin-aarch64-${bunVersion}.tgz";
      hash = "sha512-MXdZkP1featqxZ+/VTXWG1BVjM4OGBehVY2Q88EeUj/7L0UMeCGItmyPYTN+wxvlGJ6F66JEtzsw+GvQWewnag==";
    };
    x86_64-linux = fetchurl {
      url = "https://registry.npmjs.org/@oven/bun-linux-x64/-/bun-linux-x64-${bunVersion}.tgz";
      hash = "sha512-9/E/UXOTpSo3YsV5g+FhtTd/qTpiWoKuxS12cqtuYA1ssu9fRAoPQnipFgGyck3tWO63iUdxBiygq+kELFawng==";
    };
  };
  bun = stdenvNoCC.mkDerivation {
    pname = "bun";
    version = bunVersion;
    src = bunArchives.${stdenv.hostPlatform.system};
    sourceRoot = "package";
    dontBuild = true;
    dontStrip = true;
    nativeBuildInputs = lib.optionals stdenv.hostPlatform.isLinux [autoPatchelfHook];
    installPhase = ''
      install -Dm755 bin/bun $out/bin/bun
      ln -s bun $out/bin/bunx
    '';
  };
in
  stdenv.mkDerivation {
    pname = "operator";
    version = packageJson.version;
    src = ../.;
    nativeBuildInputs = [bun bun2nix.hook makeWrapper];
    bunDeps = bun2nix.fetchBunDeps {bunNix = ./bun.nix;};
    dontRunLifecycleScripts = true;
    dontUseBunBuild = true;
    dontUseBunCheck = true;
    dontUseBunPatch = true;
    dontFixup = true;

    buildPhase = ''
      runHook preBuild
      test "$(bun --version)" = "${bunVersion}"
      bun scripts/release.ts build --out dist --commit ${commit}
      mkdir runtime
      cp package.json bun.lock runtime/
      (cd runtime && bun install --frozen-lockfile --production --ignore-scripts \
        --linker=hoisted --backend=copyfile)
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      root=$out/lib/operator
      mkdir -p $root/node_modules/@fveracoechea $out/bin $out/share/skills
      cp -R runtime/node_modules/. $root/node_modules/
      cp -R dist $root/node_modules/@fveracoechea/operator
      cp bun.lock $root/bun.lock
      ln -s ../../lib/operator/node_modules/@fveracoechea/operator/skills $out/share/skills/operator
      makeWrapper ${bun}/bin/bun $out/bin/operator \
        --add-flags $root/node_modules/@fveracoechea/operator/cli.js
      runHook postInstall
    '';

    passthru = {inherit bun;};
    meta.mainProgram = "operator";
  }
```

The prototype links the whole `skills/` folder, so `README.md` is in it too.
Recommendation 6 links each skill folder instead.
