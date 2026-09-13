# Bun distribution and quality toolchain: verification report

Resolves [Verify Bun distribution and quality toolchain](https://github.com/fveracoechea/operator/issues/4) on the map [Map the first Operator orchestration workflow](https://github.com/fveracoechea/operator/issues/1). Research only; nothing here implements the production toolchain.

## Scope and method

- Primary sources: Bun docs (https://bun.com/llms.txt index), GitHub Packages docs (docs.github.com), Changesets npm metadata and `changesets/action` manifests, Oxc npm registry metadata and oxc.rs docs, Bun/TypeScript docs.
- Report date: 2026-09-12. Isolated probes ran in `/tmp/opencode` disposable directories on Linux, Bun **1.3.14** (`~/.volta/bin/bun`), Node v24.11.1, npm 11.5.2. No credentials, no publication, no global config or installs. Commands and key results are recorded below; the CLI E2E example includes both source files.
- The target repo `fveracoechea/operator` (public, default branch `main`) currently contains only `.agents`, `AGENTS.md`, `CONTEXT.md`, `README.md`, `docs`, `skills-lock.json`: **no `package.json`, no `bin`, no CLI**.

**Verification boundary.** The probes verify the *mechanics* of Bun's distribution paths using third-party GitHub repos (`typicode/husky`) and synthetic local packages. They do **not** verify an Operator CLI, because none exists yet. "The requested invocation works" below means: the invocation path is supported by Bun and will execute a bin from a GitHub source repo; a future Operator CLI could still hit its own blockers (missing bin declaration, untrusted lifecycle scripts, shebang/runtime choices) that these probes did not pre-clear.

## 1. `bunx github:fveracoechea/operator some-operation`

### Observed current failure

```
$ bunx github:fveracoechea/operator some-operation
Resolving dependencies
Resolved, downloaded and extracted [1]
Saved lockfile
error: could not determine executable to run for package
exit=1
```

Bun resolved and downloaded the GitHub repo (the `github:` source path works); the run failed because the repo has no `package.json` with a `bin` entry. This is the observed current failure, not a prediction that nothing else will ever block the unbuilt CLI.

### Source syntax and pinning (probed, Bun 1.3.14)

```
$ bunx github:typicode/husky --version          # bin executed, exit 0
$ bunx github:typicode/husky#v9.1.7 --version   # tag pin resolved and ran, exit 0
$ bunx github:typicode/husky#799e84b716d0e03db80db5d5b0dcdd15b9d555fc --version
                                                # commit-SHA pin resolved and ran, exit 0
```

- `#tag` and `#sha` pinning both work for `github:` bunx invocations (re-run to confirm repeatability of the tag pin).
- Docs also document `bun add` git protocols: `git+https://...`, `git+ssh://...#ref`, `git@github.com:...`, `github:user/repo#version`; "when possible, Bun downloads GitHub dependencies as HTTP tarballs" (https://bun.com/docs/guides/install/add-git.md). Probed: `bun add github:typicode/husky` wrote `"husky": "github:typicode/husky"` to `dependencies` and resolved in `bun.lock`.
- `bunx` flags: `--bun` (force Bun runtime), `-p <pkg> <bin>` (binary name differs from package name), `--no-install`, `--silent`, `--verbose` (https://bun.com/docs/pm/bunx.md). Probed: `bunx -p pkg-a bar` runs bin `bar` of locally installed `pkg-a`.
- **Note:** the official `bunx` doc page documents npm packages only; the `github:` bunx form is confirmed by the probes above and by Bun's issue tracker, not by the doc page. Unpinned/`#HEAD` resolution caching is tracked in [`bunx github:username/repo#HEAD should not get cached` (oven-sh/bun#27379, open)](https://github.com/oven-sh/bun/issues/27379).

### Bin selection (probed)

- `bunx <name>` selects from the package's declared `bin` map by **binary name**, not package name: with `"bin": {"foo": "./cli.js", "bar": "./bar.js"}`, both `bunx foo` and `bunx bar` ran. A single-bin package runs under its own name (`bunx github:typicode/husky` ran the `husky` bin).
- Probe lesson: an executable file inside an installed package is **not** reachable by `bunx` unless declared in the package's `bin` field. `bunx needsbun` hit `GET https://registry.npmjs.org/needsbun - 404` until `needsbun` was added to the `bin` map and reinstalled.
- Consequence: the Operator package must ship a `bin` entry. With one bin named exactly like the package (`"name": "operator"`, `"bin": {"operator": ...}`), `bunx github:fveracoechea/operator some-operation` runs `operator some-operation`.

### Shebangs and launchers (probed)

- Bun **respects shebangs** (https://bun.com/docs/pm/bunx.md: "By default, Bun respects shebangs... To run the executable with Bun's runtime instead, pass the `--bun` flag").
- A bin with `#!/usr/bin/env bun` executed **successfully through an npm/Node-based launcher**: `npm exec --no -- foo` in a project with the package installed printed `foo ran under bun 1.3.14` (exit 0). The launcher resolves the shebang's `bun` from PATH; it does not invoke Node on the file.
- Explicit `node file.js` on a Bun-API-using file fails (no `Bun` global under Node). Conversely, a `#!/usr/bin/env node` bin ran under Node (`typeof Bun === "undefined"`) and the same file via `bunx --bun needsbun` printed `Bun API present: 1.3.14` (Bun runtime).
- A `#!/usr/bin/env bun` bin can run through a launcher that honors shebangs, provided `bun` is on PATH. The shebang alone does not prevent explicit `node file.js`; a Bun-specific API or syntax then determines whether that unsupported invocation fails. The map already requires Bun for Operator CLI code, so Node runtime compatibility is not a requirement.

### Lifecycle scripts: documented trust behavior (probed)

- Bun documents "default-secure" trust: lifecycle scripts run only for `trustedDependencies` (https://bun.com/docs/pm/lifecycle.md). Probed with a `file:` dependency carrying a `postinstall`:
  ```
  $ bun install
  Blocked 1 postinstall. Run `bun pm untrusted` for details.
  ```
  After adding `"trustedDependencies": ["pkg-a"]` to the consumer's `package.json` and reinstalling, the script ran (marker file written).
- Docs: the built-in default trusted list applies **only to npm-sourced packages**; "for packages from other sources (such as `file:`, `link:`, `git:`, or `github:` dependencies), you must explicitly add them to `trustedDependencies`" (https://bun.com/docs/pm/lifecycle.md).
- Exact flags: `bun install --trust` (add to `trustedDependencies` and install), `bun install --ignore-scripts` (skip all). Whether `bunx` accepts a trust flag is UNVERIFIED; the docs document `--trust` only for `install`/`add`.
- **Recommendation:** ship an entry point that does not require install-time build scripts. Check its dependencies too; removing Operator's own scripts does not remove dependency lifecycle requirements. The probes verify blocked and explicitly trusted scripts, not a future dependency tree.

## 2. GitHub source install vs GitHub Packages registry install

These are different delivery paths and must not be conflated:

| | `bunx github:fveracoechea/operator` (source) | GitHub Packages npm registry |
|---|---|---|
| Resolution | Git/HTTP tarball of the repo at a ref | npm registry `https://npm.pkg.github.com` |
| Auth | None for a public repo (probed: bunx installed the public repo with no token) | **Token required to install even public packages** (docs: "You need an access token to publish, install, and delete private, internal, and public packages"; probed: unauthenticated `GET https://npm.pkg.github.com/@github%2fpaste-markdown` returns **401**) |
| Naming | Repo name; bin map decides | Scoped only: `@fveracoechea/operator`; `publishConfig.registry` or `.npmrc` scope mapping; `repository` field must match the repo |
| Versioning | Git refs (tags/SHAs) | Semver versions in the registry |
| Consumers | Anyone with network access to GitHub | Anyone **with a GitHub token**, even for public packages (PAT classic `read:packages`) |

Sources: https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry and https://docs.github.com/en/packages/managing-github-packages-using-github-actions-workflows/publishing-and-installing-a-package-with-github-actions. Probe notes: for a package that does not exist, the registry returns 404 (`{"error":"npm package \"operator\" does not exist under owner \"fveracoechea\""}`); for existing packages unauthenticated, 401.

Consequence: the requested frictionless invocation is the **GitHub source** path. GitHub Packages adds auth friction for every consumer and only matters if registry semantics (private distribution, semver range resolution) are wanted. Which path becomes the contract is a map decision.

## 3. Changesets and GitHub Actions release flow (doc-verified, not run)

The release flow was not executed end to end. The Operator later checked that `bunx --bun changeset --version` returned `3.0.2` with exit 0 from an isolated project with that version installed. This verifies CLI startup under Bun, not versioning, authentication, or publication. The Action versions below were checked from primary sources only:

- `@changesets/cli` latest on npm: **3.0.2** (https://registry.npmjs.org/@changesets/cli, `dist-tags.latest`).
- [`changesets/action`](https://github.com/changesets/action) latest release: **v2.1.2**; its [`action.yml`](https://raw.githubusercontent.com/changesets/action/main/action.yml) declares `runs.using: node24`, `main: dist/index.js` (primary manifest; verified by fetch). Behavior per its README/docs: on push to main it opens/updates a "Version Packages" PR, or runs the `publish` script when that PR merges.
- Required workflow permissions per the action README: `contents: write`, `pull-requests: write` (`id-token: write` only for npm Trusted Publishing), plus the repo setting "Allow GitHub Actions to create and approve pull requests".
- The publish script is arbitrary; the Changesets guide states verbatim: "Pass `registry-url: https://npm.pkg.github.com/` and `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` to publish to the GitHub Package Registry instead of npm" (https://changesets.dev/guide/automating). GitHub's documented pattern is `actions/setup-node` with `registry-url` + `NODE_AUTH_TOKEN`, job `permissions: packages: write` (plus `contents: read`).
- CI gate: `changeset status --since main` exits 1 if changed packages lack changesets (https://changesets.dev/guide/automating).
- For a Bun-based release workflow, [`oven-sh/setup-bun`](https://github.com/oven-sh/setup-bun) (its [`action.yml`](https://raw.githubusercontent.com/oven-sh/setup-bun/main/action.yml) also declares `runs.using: node24`) installs Bun on the runner to run `bun install`/`bun test` before the Changesets steps.

## 4. CLI E2E testing with Bun: subprocess probe (probed)

The ticket asked for a Bun CLI E2E probe. A synthetic self-contained CLI (`cli.ts`) was exercised through `bun test` using `Bun.spawn`, asserting args, stdout, stderr, and exit status. Reproducible snippet (all three tests pass, `bun test` exit 0):

`cli.ts`:

```ts
#!/usr/bin/env bun
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "greet") { console.log(`hello ${rest[0] ?? "world"}`); process.exit(0); }
if (cmd === "explode") { console.error("boom: bad operation"); process.exit(2); }
console.error(`unknown operation: ${cmd ?? "(none)"}`); process.exit(1);
```

```ts
// cli.test.ts
import { describe, test, expect } from "bun:test";

function run(...args: string[]) {
  return Bun.spawn(["bun", "cli.ts", ...args], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("cli e2e", () => {
  test("args reach the process and stdout is captured", async () => {
    const p = run("greet", "crew");
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    expect(stdout).toBe("hello crew\n");
    expect(stderr).toBe("");
    expect(code).toBe(0);
  });

  test("stderr and nonzero exit status are captured", async () => {
    const p = run("explode");
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    expect(stdout).toBe("");
    expect(stderr).toContain("boom");
    expect(code).toBe(2);
  });

  test("unknown operation exits 1 with usage on stderr", async () => {
    const p = run("nonsense");
    const [, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    expect(stderr).toContain("unknown operation");
    expect(code).toBe(1);
  });
});
```

Result:

```
$ bun test
bun test v1.3.14
 3 pass
 0 fail
 8 expect() calls
Ran 3 tests across 1 file. [33.00ms]
$ bun test; echo $?
0
```

This pattern (spawn the real bin, assert stdout/stderr/exit code) transfers directly to the future Operator CLI once it exists. It probes the CLI as a subprocess, not through `bunx github:` (which would need a published/pushed bin; the mechanics of that path are covered by section 1).

## 5. Quality toolchain under Bun

All probed on Bun 1.3.14, isolated temp dirs. Exact versions resolved by `bun pm ls` in the probe project: **typescript@7.0.2**, **@types/bun@1.4.2** (from `bun add -d @types/bun typescript` at probe time; versions move, pin deliberately in the real repo).

| Tool | Version tested | Probe and result |
|---|---|---|
| `tsc --noEmit` (explicit type checking) | typescript 7.0.2, @types/bun 1.4.2 | `bunx tsc --noEmit` with the Bun-recommended tsconfig reported real type errors and **exit 1**; a clean file passed. Bun never type-checks at runtime; explicit `tsc --noEmit` is the check. |
| tsconfig for Bun | @types/bun 1.4.2 | Documented config: `target/module: ESNext`, `module: "Preserve"`, `moduleResolution: "bundler"`, `types: ["bun"]`, `strict`, `noEmit`, `skipLibCheck` (https://bun.com/docs/typescript.md). Probed: without `types: ["bun"]`, tsc fails with `Cannot find name 'Bun'`; with it, `Bun.env` resolves. Caveats observed: (a) passing files on the tsc command line bypasses the tsconfig (`error TS5112: tsconfig.json is present but will not be loaded if files are specified on commandline`), so the check must rely on tsconfig `include`; (b) with `skipLibCheck: false`, bun-types internals themselves errored, so keep `skipLibCheck: true`. |
| `oxlint` | 1.82.0 | `bunx oxlint@1.82.0 bad.js` flagged `no-unused-vars` and comparison issues, exit 0 (warnings). Semver-stable per Oxc's versioning policy (https://oxc.rs/docs/guide/usage/linter/versioning). |
| `oxfmt` | 0.67.0 (pre-1.0) | `bunx oxfmt@0.67.0 --check bad.js` detected format issues, **exit 1**; suggests `oxfmt --init`. Oxc states oxfmt passes 100% of Prettier's JS/TS conformance tests, but oxfmt has no stable/semver label on oxc.rs yet (https://oxc.rs/docs/guide/usage/formatter). |
| `bun test` | Bun 1.3.14 | Unit level: 1 pass + 1 fail file produced correct output and **exit 1** on failure; `--coverage` accepted. E2E subprocess level: section 4. Docs: Jest-like API, TS/TSX builtin, `--coverage` (text/lcov), JUnit reporter, GitHub Actions annotations, happy-dom for DOM (not jsdom); partial Jest compatibility (https://bun.com/docs/test/index). |

The Operator repeated the TypeScript check with the Bun runtime forced:

- `bunx --bun tsc --noEmit -p tsconfig.json`: exit 1, diagnostics TS2322 and TS2339 for the intentional type errors below.
- `bunx --bun tsc --noEmit -p tsconfig.operator-clean.json`: exit 0, no diagnostics. This configuration extends the first and selects only the clean fixture.
- `bun test` in the CLI E2E fixture: 3 pass, 0 fail, 8 assertions, exit 0.

The TypeScript probe used `target: "ESNext"`, `module: "Preserve"`, `moduleResolution: "bundler"`, `types: ["bun"]`, `strict: true`, `noEmit: true`, and `skipLibCheck: true`. Its error fixture was:

```ts
const port: number = Bun.env.PORT ?? "3000" as unknown as number;
console.log(port.toUpperCase());
```

Its clean fixture was:

```ts
export function greet(name: string): string {
  return `hello ${name}`;
}
```

### oxlint/oxfmt package architecture (verified against npm registry metadata)

- The npm packages ship a **JS wrapper bin** plus **napi native addon packages**: `oxlint@1.82.0` has `bin: {"oxlint": "bin/oxlint"}` and 19 optionalDependencies `@oxlint/binding-*` (e.g. `@oxlint/binding-darwin-x64`, `@oxlint/binding-linux-x64-gnu`); `oxfmt@0.67.0` has the same shape with `@oxfmt/binding-*`. The binding packages ship `.node` napi addons (verified: `@oxlint/binding-linux-x64-gnu` 1.82.0 ships `oxlint.linux-x64-gnu.node`; `@oxfmt/binding-linux-x64-gnu` 0.67.0 ships `oxfmt.linux-x64-gnu.node`).
- Probed runtime compatibility: `bunx --bun oxlint@1.82.0 --version` and `bunx --bun oxfmt@0.67.0 --version` both succeeded under the Bun runtime (exit 0), so the napi addons load under Bun.
- These tools are **development-time tools**, not Operator runtime code. Whether the Bun-only rule also constrains their launchers remains a decision in the map.

## 6. Bun CLI runtime vs third-party Action runtimes

- The Operator CLI's runtime is selected at invocation: the bin's shebang, or `bunx --bun`, or `bun` explicitly. A `#!/usr/bin/env bun` bin runs under Bun from any shebang-honoring launcher with `bun` on PATH (section 1).
- Third-party GitHub Actions are separate programs on the CI runner: `changesets/action` v2.1.2 declares `runs.using: node24` and `oven-sh/setup-bun` declares `runs.using: node24` in their primary `action.yml` manifests (fetched from `main`). They run on Node.js, not Bun; that is CI tooling runtime, not the Operator runtime.
- No conflict was found between a Bun-only Operator CLI and this Actions setup. Whether the Bun-only expectation extends to dev-time tools (lint/format/type-check launchers) is a scope decision for the map; the probed facts are that oxlint/oxfmt work under both runtimes and that the Actions manifest runtimes are Node.

## Versions

| Component | Version | How established |
|---|---|---|
| Bun (local probe) | 1.3.14 | Tested: local `bun --version` |
| Bun (latest stable) | 1.4.2 (2026-09-05) | Doc-verified: https://github.com/oven-sh/bun/releases/tag/bun-v1.4.2 |
| typescript | 7.0.2 | Tested: `bun pm ls` in probe project |
| @types/bun | 1.4.2 | Tested: `bun pm ls` in probe project |
| oxlint | 1.82.0 | Tested via bunx; registry metadata: https://registry.npmjs.org/oxlint (latest) |
| oxfmt | 0.67.0 | Tested via bunx; registry metadata: https://registry.npmjs.org/oxfmt (latest) |
| @changesets/cli | 3.0.2 | Registry metadata plus `bunx --bun changeset --version`; release commands not tested |
| changesets/action | v2.1.2 | Doc-verified: GitHub latest release + `action.yml` manifest |
| oven-sh/setup-bun | node24 action, bun-version input | Doc-verified: `action.yml` manifest |

## Observed failures and limitations

1. `bunx github:fveracoechea/operator some-operation`: `error: could not determine executable to run for package` (exit 1). Observed cause: the repo has no `package.json`/`bin`. Other future blockers are possible and not pre-cleared.
2. `bunx` ignores undeclared executables inside installed packages (404 against the npm registry for the bare name).
3. Lifecycle scripts of `github:`/`file:` sources are blocked unless explicitly `trustedDependencies`-trusted; bunx-specific trust flags are undocumented.
4. GitHub Packages: unauthenticated installs of even public packages fail (401, probed).
5. tsc CLI-file invocation does not load the project tsconfig (`error TS5112` in this probe). Use project mode, such as `tsc --noEmit -p tsconfig.json`, rather than passing source file arguments.

## Unverified claims

- `bunx github:user/repo#<branch>` and semver-range pins on `github:` specs (tag/SHA probed OK; branch and semver taken from docs/issue tracker only).
- `bunx`-specific trust flag (`--trust`) behavior.
- Unpinned/`#HEAD` resolution caching between runs ([oven-sh/bun#27379](https://github.com/oven-sh/bun/issues/27379), open).
- The full Changesets + GitHub Packages release flow end to end (doc-verified; no workflow run without approval to publish).
- That an Operator CLI built per this report will run via `bunx github:` with no further blockers: the mechanics are verified with third-party and synthetic packages; the actual CLI does not exist yet.
- Standalone (non-napi) oxlint/oxfmt binaries on GitHub releases (reported from https://github.com/oxc-project/oxc/releases/tag/apps_v1.82.0; the npm/napi path above is the one verified).

## Stability requirements and decision questions for the map

1. Bin naming: ship exactly one bin named `operator` so `bunx github:fveracoechea/operator some-operation` needs no `-p` flag (subcommands inside one bin)?
2. Shebang/runtime contract: `#!/usr/bin/env bun` on the bin (any shebang-honoring launcher works; explicit `node` execution does not), or a `node` shebang plus `bunx --bun`? This fixes the Bun-only scope for consumers; it is a human decision.
3. Distribution: GitHub source as the primary path (no auth, ref-pinned); is GitHub Packages wanted at all given every consumer needs a `read:packages` token?
4. Pin/update policy: pin exact versions of typescript, @types/bun, oxlint, oxfmt, and Bun in CI (`bun-version` input, `changesets/action@v2.1.2` or a SHA pin), with a deliberate, reviewed upgrade cadence; treat oxfmt's pre-1.0 semver as a reason for stricter pinning, not a reason to swap formatters.
5. Release flow: adopt `changesets/action` with the doc-endorsed GitHub Packages env (`registry-url: https://npm.pkg.github.com/`, `GITHUB_TOKEN`) if registry distribution is chosen; verify the flow end to end only at implementation time with publish approval.
