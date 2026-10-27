# Nix package of the same release

Issue #257 delivers the device release through a locked Nix flake.
ADR-0007 is the decision source, and #205 holds the research.
The package holds the same built artifact as the JSR release, from the same commit, with the same release record and artifact identity.

## Ownership

| Owner | Responsibility |
| --- | --- |
| `flake.nix` | Exposes `packages.<system>.default`, the `bun2nix` app, and the checks for `aarch64-darwin` and `x86_64-linux`. Records `self.rev` as the commit and `self.lastModified` as the commit time. |
| `nix/package.nix` | Fetches the Bun that `packageManager` pins, installs the locked packages through bun2nix, runs `scripts/release.ts build`, and lays out the output. |
| `nix/bun.nix` | Generated from `bun.lock` by the pinned bun2nix CLI. Never edit it by hand. |
| `nix/checks.nix` | The flake checks. Each one runs the installed package in isolated device roots. |
| `scripts/release.ts` | Refuses a build without a full 40-character commit or without `SOURCE_DATE_EPOCH`, and writes the Nix launcher through `GlobalLauncher.nixText`. |
| `global-launcher/plan.ts` | The one rendering of the Nix launcher text, and the parser that readiness uses for both launchers. |

## Package layout

```text
bin/operator                                     launcher: pinned Bun on the release
lib/operator/node_modules/@fveracoechea/operator the release artifact, byte for byte
lib/operator/node_modules/<runtime packages>     production packages from bun.lock
share/skills/operator/<name>                     one link per owned skill folder
```

The release folder sits where Bun's global folder puts a JSR install, so the artifact finds its packages the same way.
There is no `package.json` beside it, so readiness reads no Bun pin for the Nix path.
The flake lock of the consumer pins the package instead.
`passthru.skills` lists the owned skill names, read from the source at evaluation time, so a consumer can link every one without building first.

## Same release on every path

- The build runs the same `bun scripts/release.ts build` as the release job, with the Bun that `packageManager` pins.
  The build refuses a different Bun.
- The hook's shebang patch and the fixup phase are off, because both rewrite bytes that the artifact identity covers.
- The release record names the commit time as `builtAt`.
  The release job sets `SOURCE_DATE_EPOCH` from `git log -1 --format=%ct`, and the flake sets it from `self.lastModified`.
  `release.ts build` refuses without it, so no path records a machine clock.
- A tag input `github:fveracoechea/operator/v<version>` records the commit of that tag.
- `release.ts build` refuses a `--commit` that is not 40 lowercase hexadecimal characters.
  Thus a dirty checkout (`<rev>-dirty`) or a source with no Git revision (`unknown`) does not build, and no release names a false commit.
- No runtime fetch: the launcher runs the pinned Bun on `cli.js`, and all packages are in the store.

## Launcher and command discovery

`bin/operator` is a `sh` launcher from `nixLauncherText`:

```sh
#!/bin/sh
# Operator launcher written by the Nix package.
# It runs the release in this package with the package's pinned Bun.
PATH=${PATH:+$PATH:}'<bun>/bin' exec '<bun>/bin/bun' '<out>/lib/operator/node_modules/@fveracoechea/operator/cli.js' "$@"
```

Readiness reads this text with the same parser as the JSR launcher and requires that it runs the running release.
Any other text is `executable_mismatch`.
The pinned Bun goes last on `PATH`, so `operator install matt` reaches an installer on a device with no other Bun, and a person's own Bun still comes first.

## Skills

Consumers link `share/skills/operator/<name>` from their own configuration.
The `programs.claude-code.skills` and `programs.opencode.skills` options of Home Manager `release-26.05` take a store path for each name, and write a folder that holds one link to each file.
A plain link to each skill folder also works, because check mode compares the content behind the links.
Operator adds no Home Manager module and changes no Nix wiring.
Owned installation is check-only, because the running skills resolve under `/nix/store/`.
A missing or changed link is a readiness blocker that names the consumer-owned Nix links.
Delegated upstream installation stays available.

## Flake checks

| Check | Proof |
| --- | --- |
| `version` | After registration, `operator --version` prints the package version, and the JSON names the pinned Bun, the flake commit, and the artifact identity of the release record. |
| `artifact` | The artifact's own `OperatorRelease.inspect` finds every required part and recomputes the recorded identity. The record names the flake commit and the commit time. `cli.js` keeps `#!/usr/bin/env bun`. The skill links match the skill folders and `passthru.skills`. |
| `dependencies` | The pinned bun2nix writes `nix/bun.nix` again from `bun.lock`, and the result is identical. |
| `discovery` | A hook environment with only a profile link to the command, Git, and controlled `gh`, `herdr`, `claude`, and `opencode` reaches the command through `PATH`. Readiness is `ready` with skills linked from the package: Claude Code gets the Home Manager shape, a folder of file links, and OpenCode gets one link to each skill folder. `install --claude --opencode` reports `skills_checked` and leaves both host folders unchanged. A removed link blocks readiness, and install does not repair it. `install matt` reaches the pinned Bun and fails only at an unreachable registry. |

`release-smoke.yml` runs `nix flake check -L` and `nix build --rebuild` on `ubuntu-latest` (x86_64-linux) and `macos-latest` (aarch64-darwin).
It then builds the artifact the way the release job does and requires `diff -r` to find no difference from the Nix artifact.
It also builds `github:<repository>/<commit>`, the input form that consumers pin, and requires the same `diff -r` result.
That input takes its commit time from the GitHub archive and not from the local checkout.

To refresh `nix/bun.nix` after a lock change:

```sh
nix run .#bun2nix -- -l bun.lock -o nix/bun.nix
```

Each Bun update needs both archive hashes in `nix/package.nix`, from `https://registry.npmjs.org/@oven/<archive>/<version>`.

## Known costs and limits

- bun2nix brings `flake-parts`, `treefmt-nix`, and `systems` into the consumer lock.
  Because the flake makes bun2nix follow `nixos-26.05`, its CLI and cache tool build from source for a consumer with no matching binary cache.
- `fetchBunDeps` fetches every package in `bun.lock`, including the native packages of other platforms.
- On Linux the runtime packages are not patched, so a prebuilt binary inside a runtime package, such as the agent SDK's bundled host, does not run on NixOS.
  The current CLI does not run it.
- A `bunfig.toml` preload in the working folder runs before the CLI, the same as on the JSR path.
- The `discovery` check simulates the Herdr hook environment through `PATH` and a controlled `herdr` only.
  No Herdr process runs the Nix command.
  #247 proved real Herdr hook execution through a global source install only.
- `release.yml` runs `release-smoke.yml`, so each publish now waits for the `nix` job on a Linux and a macOS runner, including the bun2nix Rust build.
  A Nix cache or runner failure can thus stop a release.
- `install-nix-action` leaves the Nix sandbox off on macOS runners.
  Only the x86_64-linux job proves that the build and checks run with no network.

## Verification

GitHub Actions run 40518954152 ran the `nix` job of `release-smoke.yml` on `ubuntu-latest` (x86_64-linux) and `macos-latest` (aarch64-darwin), on this change with a temporary push trigger only.
Both jobs passed: `nix flake check -L` with all four checks, `nix build --rebuild .#default`, `diff -r` between the Nix artifact and a Bun 1.4.2 `release.ts build` of the same commit, and the same `diff -r` for the `github:` input of that commit.
An earlier version of `discovery` failed in run 40517695253 only at its cleanup, because `cp -rs` kept the read-only store mode. Readiness and check-only install had passed with the Home Manager shape.

Before CI, x86_64-linux also ran in a `nixos/nix` container on Apple Silicon (`--platform linux/amd64`, emulated), with Nix 2.35.4 and `sandbox = true`.
The container needs `filter-syscalls = false`, because seccomp cannot load under emulation.

| Command | Result |
| --- | --- |
| `nix flake check -L` on x86_64-linux | All four checks passed. |
| `nix build --rebuild .#default` on x86_64-linux | Passed. The output is bit-identical. |
| Bun 1.4.2 `bun install --frozen-lockfile`, then `release.ts build` with the commit time, then `diff -r` with the Nix artifact | No difference, `release.json` included. |
| `nix flake check --all-systems --no-build` | Passed. The aarch64-darwin outputs evaluate. |
| `bun run quality` through the locked gate on macOS | Static checks passed. Tests: 728 pass, 32 fail, the same 32 that fail at the base commit `4e78fea`. |

No Nix build ran on the macOS development device, so the aarch64-darwin proof is the CI run alone.

Each deliberate break below ran on a copy of the tree, and the named check failed for the stated reason:

| Break | Check | Failure |
| --- | --- | --- |
| Remove `dontUseBunPatch` | `artifact` | `cli.js` lost its shebang. |
| Remove `dontFixup` | `discovery` | `executable_mismatch`, because the fixup rewrites the launcher shebang. |
| Remove `SOURCE_DATE_EPOCH` from the package | `artifact` | The record names 1980-01-01, not the commit time. |
| Link only some skill folders | `artifact` | The links differ from the skill folders. |
| Change one hash in `nix/bun.nix` | `dependencies` | `nix/bun.nix` is stale. |
| Edit the installed launcher text | `discovery` | Readiness is not ready. |
| Drop the pinned Bun from the launcher `PATH` | `discovery` | `upstream_installer_unavailable`. |
| Record another commit | `version` | The commit does not match. |
| Remove the `SOURCE_DATE_EPOCH` refusal in `release.ts` | `operator-release/main.test.ts` | Two release tooling tests fail. |
| Ignore the Nix form in `launcherTarget` | `plan.test.ts`, `run.launcher-guards.test.ts` | The Nix launcher test fails. |
| Accept any `--commit` in `release.ts build` | `operator-release/main.test.ts` | The full clean commit test fails. |
| Drop the invalid date refusal in `release.ts build` | `operator-release/main.test.ts` | The commit time test fails on a 20-digit epoch. |
| Accept a relative `--root` or `--bun` in `release.ts launcher` | `operator-release/main.test.ts` | The Nix launcher tooling test fails. |

Removing `dontFixup` does not change the artifact identity, because no artifact file is executable.
The launcher is executable, so the discovery check is its guard.
