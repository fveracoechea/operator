# Jarvis and Cerebro oxlint rules for Operator

Date: 2026-10-06.
Research for [Scan the Jarvis and Cerebro oxlint rules for Operator](https://github.com/fveracoechea/operator/issues/200) in [Map the global Operator home and the source reset](https://github.com/fveracoechea/operator/issues/199).
This report gives facts and recommendations.
The decision is [Choose the Jarvis and Cerebro oxlint rules for Operator](https://github.com/fveracoechea/operator/issues/201).

## Sources

All sources are local checkouts.
I did not change them.

| Repo                         | Commit     | Files read                                                                                                                                                                                                                                                                                                         |
| ---------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Jarvis (`terzo-ai/jarvis`)   | `2f4b136`  | `oxlint.config.ts`, `configs/oxlint.ts`, `configs/oxlint-plugin.ts`, `configs/oxlint-plugin/*.ts`, `agent-policies/oxlint-rules.ts`, `.github/workflows/oxlint-rule-drift.yml`, `.github/actions/oxlint-drift/action.yml`, `cli/commands/oxlint/README.md`, `docs/adr/0015-jarvis-ships-a-shared-oxlint-config.md` |
| Cerebro (`terzo-ai/cerebro`) | `2fbdf849` | `oxlint.config.ts`, `tools/oxlint/**`, `docs/anti-slop-rules.md`, `.github/workflows/oxlint-rule-drift.yml`                                                                                                                                                                                                        |
| Operator                     | `84ec29b`  | `.oxlintrc.json`, `tools/oxlint/anti-slop/*`, `scripts/check-module-shape.ts`, `dependency-cruiser.config.cjs`, `package.json`, `tsconfig.json`                                                                                                                                                                    |

## Method

I wrote two temporary oxlint configs outside the repo.
Each config holds Operator's current rules and every candidate rule.
The syntax config loads Operator's `anti-slop` plugin, Cerebro's `anti-slop` plugin under the alias `cerebro-slop`, Cerebro's `tautological-tests.ts`, and the Jarvis plugin `configs/oxlint-plugin.ts`.
It turns on the `eslint`, `typescript`, `unicorn`, `oxc`, `import` and `promise` plugins, as Jarvis and Cerebro do.
It runs with Operator's installed oxlint 1.83.0 on the paths of `bun run lint`.
The type-aware config runs with Cerebro's oxlint 1.86.0 and `oxlint-tsgolint` 7.0.2003, because Operator has no `oxlint-tsgolint`.
The Jarvis plugin reads `settings.jarvis`, and I set `modulesRoot` to `modules` and `aliases` to `{}`.
I ran `jarvis/env-through-schema` with an empty `allowFiles`, so that every raw env read counts.
`jarvis/module-entry-imports` found no violation, so I ran it on a small fake module tree to prove that it can fail with this layout.
It reported the import of a private file and accepted the import of `main.ts`.

Counts split three ways.
"Prod" is production code in `modules/`, `herdr/` and `cli.ts`.
"Test" is `*.test.ts`, `*-fixture.ts`, `*.preload.ts` and `fake-*.ts`.
"Tools" is `scripts/` and `tools/oxlint/`.
Operator lints all three today, so each count is a lint failure on adoption.
`bun run lint` passes `--deny-warnings`, so a rule at `warn` also fails the lint.

`oxlint --print-config` for Operator's config shows that no candidate rule is on today.
Operator's default plugins are `unicorn`, `typescript` and `oxc`.
The `import` and `promise` plugins are off.

## What each repo has

### Jarvis

Jarvis publishes a shared config, `@terzo-ai/jarvis/oxlint`, from `configs/oxlint.ts`.
A Consumer Project spreads it into its own `oxlint.config.ts` (ADR-0015).
The ADR picks TypeScript over JSON with `extends`, because a path into `node_modules` names the install layout and breaks with no error that names Jarvis.
The shared config sets `complexity` to 30, `func-style` to declarations, and 14 rules of the `jarvis` plugin.
The Jarvis repo config adds 118 rules and sets `complexity` to 15.

The `jarvis` plugin has these rules.
Only the first three are generic.

| Rule                                                                               | What it catches                                                                                                            | Scope                      |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `env-through-schema`                                                               | A read of `process.env`, `Bun.env` or `import.meta.env` outside the files in `allowFiles`                                  | Generic                    |
| `module-entry-imports`                                                             | An import of a module file that is not an entry file (`main`, `main.server`, `$functions`, `schemas`, `schemas.generated`) | Generic                    |
| `no-module-factory`                                                                | An export named `create[A-Z]...` inside the modules root                                                                   | Generic                    |
| `no-route-import-in-module`, `no-client-module-entry`, `no-server-functions-in-ui` | Route, SSR and server-function boundaries                                                                                  | TanStack Start             |
| `named-select`, `suspending-query`, `query-client-methods`                         | Query usage                                                                                                                | TanStack Query             |
| `no-numbered-palette`, `alpha-steps`, `badge-variant`                              | Color tokens                                                                                                               | Mystique                   |
| `no-dom-expect-in-wait-for`                                                        | DOM assertions inside `waitFor`                                                                                            | DOM tests                  |
| `no-time-zone`                                                                     | A `timeZone` option on a date formatter                                                                                    | Dates on the viewer's zone |

Each rule message ends with the skill topic that explains the fix.
Each rule has a `*.test.ts` beside it.
`agent-policies/oxlint-rules.ts` reads which rules are on, through `oxlint --print-config` for built-in rules and through the config file for plugin rules.
The `code-style` agent policy uses it to check that a code-style section marked `Enforced by:` names a rule that is on.

### Cerebro

Cerebro spreads the Jarvis shared config and adds its own rules.
Its built-in rules include every rule of the Jarvis repo config.
Two values differ in a way that matters here.
`default-case` is off, because `typescript/switch-exhaustiveness-check` replaces it.
`import/unambiguous` is `warn`, while Jarvis turns it off because `"type": "module"` makes every file a module.
Cerebro turns on type-aware linting (`options.typeAware` and `options.typeCheck`).
It adds React rules, a `no-restricted-imports` list for its own packages, and four local plugins:

- `tools/oxlint/anti-slop/`, 12 rules vendored from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), with no tests.
- `tools/oxlint/tautological-tests.ts`, rules `custom-tests/no-fixture-assertion` and `custom-tests/no-query-options-assertion`, with tests.
- `tools/oxlint/only-export-components.ts` and `tools/oxlint/module-tsx-under-ui.ts`, both React.

`docs/anti-slop-rules.md` records how Cerebro's copy differs from upstream.
`no-unknown-parameters` also exempts the subject of a type predicate.
`no-module-mocking` detects `bun:test` only.
Cerebro's lint ignores `tools/**`, so its plugin code is not held to its own rules.

### Operator

`.oxlintrc.json` sets `complexity` to 15, `oxc/no-accumulating-spread`, and four `anti-slop` rules.
The `anti-slop` copy is pinned to upstream commit `c44ef22` and refactored to pass Operator's own lint.
`scripts/check-module-shape.ts` enforces the module shape with the TypeScript compiler API:

- Each module has `main.ts`, which exports one PascalCase object whose properties are methods.
- A file outside a module imports it only through `main.ts`, for relative, package-name, dynamic and `require` imports.
- Production code lives in `modules/`, except a short allow list.
- Only `modules/integration-branch` names `update-ref` (ADR 0020).
- Only `modules/pull-request-stack` pushes or names `/pulls` (ADR 0022).

`dependency-cruiser.config.cjs` forbids import cycles that start in `modules/`.
`tsconfig.json` sets `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters` and `noFallthroughCasesInSwitch`.

## Rules that are in both repos

| Rule                                                                     | Jarvis                         | Cerebro                  | Better for Operator                                                                                                       |
| ------------------------------------------------------------------------ | ------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `anti-slop/no-chained-type-assertions`, `anti-slop/no-widen-then-assert` | Not used                       | Upstream code, formatted | Operator's own copy. Cerebro's `no-widen-then-assert` has two functions over `complexity` 15, and Operator's copy passes. |
| `complexity`                                                             | 30 shared, 15 in the repo      | 15                       | Same as Operator (15).                                                                                                    |
| `default-case`                                                           | On, with `commentPattern`      | Off                      | Cerebro. `switch-exhaustiveness-check` reads the union type, and `default-case` only asks for a `default`.                |
| `import/unambiguous`                                                     | Off, with the reason           | `warn`                   | Jarvis. Operator also sets `"type": "module"`.                                                                            |
| `jarvis/env-through-schema`                                              | Allows the bin entry and tests | Allows `env.ts` files    | Neither fits yet. Operator has no env schema.                                                                             |
| Every other built-in rule                                                | Same value                     | Same value               | No difference.                                                                                                            |

## Results

### Zero violations

89 candidate rules find no violation in Operator.
87 run without type information.
Two need it: `typescript/consistent-type-exports` and `typescript/prefer-reduce-type-parameter`.
17 of the 87 are in the `import` and `promise` plugins, so the config must also turn those plugins on.
Turning them on adds no other violation.
The list is in the appendix.
`import/no-cycle` is one of them, and it repeats the `dependency-cruiser` cycle rule.
`oxc/no-barrel-file` is another, and it holds the rule "no barrel files" of `~/OPINIONS.md`.

`typescript/no-generated-empty-object-type` (Cerebro) is not in oxlint 1.83.0.
Oxlint 1.86.0 has it, and it finds no violation.

### Built-in rules with violations

| Rule                                                                                                          | Source        | Prod | Test | Tools | Note                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------- | ------------- | ---- | ---- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `typescript/switch-exhaustiveness-check`                                                                      | Cerebro       | 13   | 0    | 1     | Type-aware. Each hit is a `default` that takes a named union member, for example `"flaky"` in `modules/crew-state/landing.ts:124`. A new member goes to the `default` with no error. |
| `typescript/no-unsafe-type-assertion`                                                                         | Cerebro       | 5    | 158  | 1     | Type-aware. Cerebro turns it off in `*.test.*`. That leaves 24 here, because 18 hits are in fixture and fake files.                                                                  |
| `typescript/prefer-optional-chain`                                                                            | Both          | 26   | 0    | 2     | Type-aware.                                                                                                                                                                          |
| `typescript/promise-function-async`                                                                           | Cerebro       | 31   | 128  | 2     | Type-aware.                                                                                                                                                                          |
| `typescript/prefer-nullish-coalescing`, `typescript/dot-notation`, `typescript/restrict-plus-operands`        | Both, Cerebro | 3    | 0    | 2     | Type-aware.                                                                                                                                                                          |
| `eqeqeq`                                                                                                      | Both          | 15   | 0    | 0     |                                                                                                                                                                                      |
| `unicorn/prefer-single-call`                                                                                  | Both          | 13   | 2    | 0     |                                                                                                                                                                                      |
| `no-negated-condition`                                                                                        | Both          | 13   | 1    | 0     | `warn`                                                                                                                                                                               |
| `no-shadow`                                                                                                   | Both          | 9    | 22   | 0     | `warn`                                                                                                                                                                               |
| `no-empty-function`                                                                                           | Both          | 1    | 15   | 0     | `warn`                                                                                                                                                                               |
| `import/no-duplicates`                                                                                        | Both          | 5    | 1    | 0     |                                                                                                                                                                                      |
| `typescript/no-import-type-side-effects`                                                                      | Both          | 5    | 0    | 0     |                                                                                                                                                                                      |
| `typescript/consistent-indexed-object-style`                                                                  | Both          | 5    | 0    | 0     |                                                                                                                                                                                      |
| `unicorn/prefer-at`, `prefer-array-find`, `prefer-export-from`, `prefer-string-replace-all`, `prefer-ternary` | Both          | 9    | 0    | 0     |                                                                                                                                                                                      |
| `no-template-curly-in-string`                                                                                 | Both          | 0    | 2    | 1     | `warn`                                                                                                                                                                               |
| `preserve-caught-error`, `typescript/no-explicit-any`                                                         | Both          | 1    | 1    | 0     |                                                                                                                                                                                      |
| `promise/always-return`                                                                                       | Both          | 0    | 8    | 0     | `warn`                                                                                                                                                                               |
| `import/no-default-export`                                                                                    | Both          | 0    | 0    | 1     | The `anti-slop` plugin entry. Oxlint loads a plugin from its default export.                                                                                                         |
| `func-style` (declarations)                                                                                   | Jarvis shared | 42   | 76   | 3     | Holds "function declarations over named const arrows" of `~/OPINIONS.md`.                                                                                                            |
| `no-console`                                                                                                  | Cerebro       | 13   | 7    | 8     | A CLI writes to the console on purpose.                                                                                                                                              |
| `max-lines` (400)                                                                                             | Both          | 42   | 45   | 0     | `warn`                                                                                                                                                                               |
| `no-await-in-loop`                                                                                            | Both          | 116  | 104  | 3     | Operator runs Git and GitHub steps in order on purpose.                                                                                                                              |
| `prefer-destructuring`                                                                                        | Both          | 99   | 105  | 15    | `warn`                                                                                                                                                                               |
| `typescript/array-type` (`T[]`)                                                                               | Both          | 165  | 90   | 0     | `warn`                                                                                                                                                                               |
| `sort-imports`                                                                                                | Both          | 230  | 111  | 0     |                                                                                                                                                                                      |
| `typescript/consistent-type-definitions` (`interface`)                                                        | Both          | 423  | 50   | 2     | Operator writes `type` aliases.                                                                                                                                                      |
| `import/consistent-type-specifier-style`                                                                      | Both          | 615  | 107  | 0     |                                                                                                                                                                                      |

Type-aware linting also turns on oxlint's default type-aware rules.
They found these violations: `no-floating-promises` 2 (test), `await-thenable` 4 (test), `unbound-method` 3, `no-base-to-string` 3 (test), `require-array-sort-compare` 4 (test), `no-duplicate-type-constituents` 3, `no-misused-spread` 1, `no-redundant-type-constituents` 1, `restrict-template-expressions` 1.
Cerebro turns off `await-thenable` and `unbound-method` in tests, because `bun:test` types `.resolves` and `.rejects` as `void` and a mock method is unbound by design.
On this machine the type-aware run took about 1 second.

### Plugin rules with or without violations

| Rule                                                     | Source  | Prod | Test | Tools | Port cost                                                                                                                                                                                    |
| -------------------------------------------------------- | ------- | ---- | ---- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anti-slop/no-module-mocking`                            | Cerebro | 0    | 0    | 0     | Copy one file. It passes Operator's lint.                                                                                                                                                    |
| `anti-slop/no-unknown-type-aliases`                      | Cerebro | 0    | 0    | 0     | Copy one file. It passes Operator's lint.                                                                                                                                                    |
| `custom-tests/no-fixture-assertion`                      | Cerebro | 0    | 0    | 0     | Copy `tautological-tests.ts` and remove `no-query-options-assertion`, which is React Query.                                                                                                  |
| `jarvis/module-entry-imports`                            | Jarvis  | 0    | 0    | 0     | Copy the rule and `module-layout.ts`. They pass Operator's lint. It repeats `check-module-shape.ts` and checks less.                                                                         |
| `anti-slop/no-reflect-get`, `anti-slop/no-reflect-apply` | Cerebro | 4    | 1    | 0     | Copy two rules and `shared/reflect-method.ts`. They pass Operator's lint.                                                                                                                    |
| `anti-slop/no-object-parameters`                         | Cerebro | 0    | 4    | 0     | Copy the rule and `shared/lexical-type-parameters.ts`. That helper has one `no-chained-type-assertions` violation.                                                                           |
| `anti-slop/no-unknown-returns`                           | Cerebro | 8    | 7    | 0     | Copy the rule and `shared/lexical-type-parameters.ts`. One function is over `complexity` 15.                                                                                                 |
| `jarvis/no-module-factory`                               | Jarvis  | 5    | 0    | 0     | All 5 hits are verbs, not factories: `createTag`, `createRelease`, `createPull`, `createState`, `createIntegrationBranch`. `check-module-shape.ts` already makes `main.ts` export an object. |
| `anti-slop/no-runtime-typeof`                            | Cerebro | 42   | 3    | 2     | Copy one file. Many hits are the parse step itself, for example `modules/github-tracker/main.ts:93`.                                                                                         |
| `anti-slop/no-unknown-parameters`                        | Cerebro | 37   | 24   | 1     | Copy one file. Many hits are parsers that take `unknown` on purpose.                                                                                                                         |
| `anti-slop/no-unsafe-dictionary-type`                    | Cerebro | 15   | 28   | 2     | Copy the rule and `shared/dictionary-types.ts` (580 lines, 5 functions over `complexity` 15).                                                                                                |
| `anti-slop/no-known-value-widening`                      | Cerebro | 95   | 20   | 0     | Same helper as above.                                                                                                                                                                        |
| `jarvis/env-through-schema`                              | Jarvis  | 16   | 76   | 3     | Operator has no env schema. Each env read moves to one module, or goes in `allowFiles`.                                                                                                      |

## Rules left out

These rules fit only React, the browser, or the domain of one repo:
`react/*`, `custom/only-export-components`, `custom-modules/tsx-under-ui`, `custom-tests/no-query-options-assertion`, `jarvis/no-route-import-in-module`, `jarvis/no-client-module-entry`, `jarvis/no-server-functions-in-ui`, `jarvis/named-select`, `jarvis/suspending-query`, `jarvis/query-client-methods`, `jarvis/no-numbered-palette`, `jarvis/alpha-steps`, `jarvis/badge-variant`, `jarvis/no-dom-expect-in-wait-for`, `jarvis/no-time-zone`, `no-alert`, `unicorn/no-document-cookie`, `unicorn/prefer-keyboard-event-key`, the `no-restricted-imports` list of Cerebro, and the `max-params` override of Cerebro.
`import/unambiguous` is left out for the reason that Jarvis gives.
`options.typeCheck` is left out, because `bun run typecheck` already runs `tsc`.

## Drift check

Both drift workflows run the composite action `.github/actions/oxlint-drift` of Jarvis.
The action reads the `reviewed-oxlint-version` field of `package.json` and the installed version in `bun.lock`.
It fails a pull request that installs an oxlint that nobody reviewed (exit 4).
It warns when the registry is a major version or 5 minor versions ahead (exit 5).
With an Anthropic key, it also posts a Claude summary of the rule changes since the reviewed version.
Jarvis has `internal` visibility in the `terzo-ai` organization.
Operator is a public repo of another owner, so it cannot call `terzo-ai/jarvis/.github/actions/oxlint-drift@main`.
A drift check in Operator needs its own copy of the check.
Operator already pins `oxlint` exactly at `1.83.0`, so a bump is a visible change in `package.json`.

## Recommendation

Rank order is the value to Operator divided by the cost to adopt.

| Rank | Rules                                                                                                                                                                                                                                                                                                 | Source        | Prod + test + tools now | Port cost                                                 | Recommend                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1    | 89 zero-violation built-in rules, with the `import` and `promise` plugins                                                                                                                                                                                                                             | Both          | 0                       | Config lines                                              | Yes                                                                                |
| 2    | `anti-slop/no-module-mocking`, `anti-slop/no-unknown-type-aliases`, `custom-tests/no-fixture-assertion`                                                                                                                                                                                               | Cerebro       | 0                       | Copy plugin rules                                         | Yes                                                                                |
| 3    | `typescript/switch-exhaustiveness-check` with type-aware linting                                                                                                                                                                                                                                      | Cerebro       | 14                      | Add `oxlint-tsgolint`, `options.typeAware`, a config line | Yes                                                                                |
| 4    | The small built-in group: `eqeqeq`, `import/no-duplicates`, `typescript/no-import-type-side-effects`, `typescript/consistent-indexed-object-style`, `preserve-caught-error`, `typescript/no-explicit-any`, `no-template-curly-in-string`, five `unicorn/prefer-*` rules, `unicorn/prefer-single-call` | Both          | 60                      | Config lines                                              | Yes                                                                                |
| 5    | `typescript/no-unsafe-type-assertion`, off in test files                                                                                                                                                                                                                                              | Cerebro       | 6 to 24                 | Config line and a test override                           | Yes                                                                                |
| 6    | Default type-aware rules, with `await-thenable` and `unbound-method` off in `*.test.ts`                                                                                                                                                                                                               | oxlint        | 18                      | Comes with rank 3                                         | Yes                                                                                |
| 7    | `anti-slop/no-reflect-get`, `anti-slop/no-reflect-apply`                                                                                                                                                                                                                                              | Cerebro       | 5                       | Copy plugin rules                                         | Yes                                                                                |
| 8    | `func-style` (declarations)                                                                                                                                                                                                                                                                           | Jarvis shared | 121                     | Config line                                               | Yes                                                                                |
| 9    | `typescript/prefer-optional-chain`, `prefer-nullish-coalescing`, `dot-notation`, `restrict-plus-operands`                                                                                                                                                                                             | Both          | 33                      | Config lines, type-aware                                  | Yes                                                                                |
| 10   | `typescript/no-generated-empty-object-type`                                                                                                                                                                                                                                                           | Cerebro       | 0                       | Bump oxlint to 1.86 or later                              | Yes, at the next bump                                                              |
| 11   | `anti-slop/no-unknown-returns`, `anti-slop/no-object-parameters`                                                                                                                                                                                                                                      | Cerebro       | 19                      | Copy rules and fix the helper                             | Later                                                                              |
| 12   | `anti-slop/no-runtime-typeof`, `anti-slop/no-unknown-parameters`                                                                                                                                                                                                                                      | Cerebro       | 109                     | Copy rules, then fix or exempt the parsers                | Later                                                                              |
| 13   | `jarvis/env-through-schema`                                                                                                                                                                                                                                                                           | Jarvis        | 95                      | Copy rule, add one env module                             | Later, with the device-home work that reads `XDG_CONFIG_HOME` and `XDG_STATE_HOME` |
| 14   | `no-shadow`, `no-negated-condition`, `no-empty-function`, `promise/always-return`, `max-lines`                                                                                                                                                                                                        | Both          | 156                     | Config lines                                              | No                                                                                 |
| 15   | `anti-slop/no-known-value-widening`, `anti-slop/no-unsafe-dictionary-type`                                                                                                                                                                                                                            | Cerebro       | 160                     | Copy a 580-line helper with 5 complexity violations       | No                                                                                 |
| 16   | `jarvis/module-entry-imports`                                                                                                                                                                                                                                                                         | Jarvis        | 0                       | Copy rule                                                 | No. `check-module-shape.ts` already enforces more.                                 |
| 17   | `jarvis/no-module-factory`                                                                                                                                                                                                                                                                            | Jarvis        | 5                       | Copy rule                                                 | No. All hits are false positives.                                                  |
| 18   | `no-console`, `no-await-in-loop`, `typescript/promise-function-async`                                                                                                                                                                                                                                 | Both          | 28, 223 and 161         | Config lines                                              | No. The CLI uses these patterns on purpose.                                        |
| 19   | `sort-imports`, `typescript/array-type`, `typescript/consistent-type-definitions`, `import/consistent-type-specifier-style`, `prefer-destructuring`                                                                                                                                                   | Both          | 219 to 722 each         | Config lines                                              | No. Style only, and some go against Operator's current style.                      |

Rank 1, 2 and 10 cost nothing now and guard against new code.
Rank 3 and 5 catch the defects that the type checker misses: a union member that falls into a `default`, and an assertion that narrows with no check.
A new plugin rule copy must pass Operator's lint, and each rule needs a test that shows it can fail.
Cerebro's anti-slop rules have no tests.

## Appendix: zero-violation rules

Built-in, no type information:
`accessor-pairs`, `array-callback-return`, `default-case`, `default-case-last`, `no-array-constructor`, `no-bitwise`, `no-else-return`, `no-empty`, `no-extend-native`, `no-extra-bind`, `no-fallthrough`, `no-implicit-coercion`, `no-labels`, `no-multi-assign`, `no-new-func`, `no-object-constructor`, `no-promise-executor-return`, `no-proto`, `no-return-assign`, `no-script-url`, `no-sequences`, `no-unexpected-multiline`, `no-unneeded-ternary`, `no-var`, `object-shorthand`, `prefer-const`, `prefer-object-has-own`, `prefer-rest-params`, `radix`, `symbol-description`, `yoda`,
`typescript/adjacent-overload-signatures`, `typescript/ban-ts-comment`, `typescript/no-confusing-non-null-assertion`, `typescript/no-empty-interface`, `typescript/no-empty-object-type`, `typescript/no-inferrable-types`, `typescript/no-non-null-assertion`, `typescript/no-require-imports`, `typescript/prefer-for-of`, `typescript/prefer-ts-expect-error`, `typescript/unified-signatures`,
`unicorn/error-message`, `unicorn/explicit-timer-delay`, `unicorn/import-style`, `unicorn/new-for-builtins`, `unicorn/no-anonymous-default-export`, `unicorn/no-array-fill-with-reference-type`, `unicorn/no-instanceof-array`, `unicorn/no-lonely-if`, `unicorn/no-new-buffer`, `unicorn/no-typeof-undefined`, `unicorn/no-useless-iterator-to-array`, `unicorn/prefer-array-some`, `unicorn/prefer-date-now`, `unicorn/prefer-default-parameters`, `unicorn/prefer-global-this`, `unicorn/prefer-includes`, `unicorn/prefer-logical-operator-over-ternary`, `unicorn/prefer-math-min-max`, `unicorn/prefer-node-protocol`, `unicorn/prefer-string-trim-start-end`, `unicorn/require-number-to-fixed-digits-argument`, `unicorn/switch-case-braces`, `unicorn/text-encoding-identifier-case`, `unicorn/throw-new-error`,
`oxc/branches-sharing-code`, `oxc/misrefactored-assign-op`, `oxc/no-barrel-file`, `oxc/no-const-enum`,
`import/default`, `import/export`, `import/newline-after-import`, `import/no-absolute-path`, `import/no-cycle`, `import/no-empty-named-blocks`, `import/no-mutable-exports`, `import/no-self-import`, `import/no-unassigned-import`,
`promise/no-multiple-resolved`, `promise/no-nesting`, `promise/no-new-statics`, `promise/no-promise-in-callback`, `promise/no-return-in-finally`, `promise/no-return-wrap`, `promise/param-names`, `promise/prefer-catch`.

Built-in, type-aware: `typescript/consistent-type-exports`, `typescript/prefer-reduce-type-parameter`.
