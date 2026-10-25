# Lint policy, issue 237

## Delivered scope

ADR-0018 records the policy decision.
The root JSON configuration enables the approved scan ranks 1 through 10, all nine unthrown rules, and the seven async and unsafe-data additions as errors.
Classic complexity is limited to 14 in production, tooling, and tests.
Lint keeps `typeCheck` off because the separate TypeScript command owns type checking.
There is no violation baseline or separate lint-version record.

The person replaced the older version requirements with latest stable versions for every dependency in the root manifest, with exact pins.
This instruction included dependencies other than lint tools.
The delivered pins are Zod 4.6.7, TypeScript 7.0.2, Bun types 1.4.4, Oxlint and its plugin API 1.89.0, oxlint-tsgolint 7.0.2005, Oxfmt 0.74.0, JSR 0.14.3, and unthrown and its Oxlint plugin 5.12.1.
The Bun engine range and package-manager field are unchanged.
The new TypeScript compiler API requires asynchronous source access under Bun.
The structural checker uses that API, and its existing deliberate-break proof remains active.

## Check ownership and proof

| Owner                                                    | Contract and proof                                                                                                                                                                                                                  |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Oxlint                                                   | Selected built-in, type-aware, and custom policy. Real root lint runs in disposable checkout copies accept valid examples and reject violations.                                                                                    |
| `scripts/oxlint-policy.test.ts`                          | Complexity 14 passes and 15 fails. All seven added checks reject violations in production and tests. Exhaustive switches cannot hide missing cases behind default. Only the three approved rules have test exceptions.              |
| `tools/oxlint/anti-slop/*.test.ts`                       | Beside-tests cover all eight retained custom rules, including aliases, computed reflection methods, shadowed bindings, and valid parse boundaries.                                                                                  |
| `tools/oxlint/custom-tests/no-fixture-assertion.test.ts` | Rejects assertions on local fixture data and accepts observed results and mutation checks.                                                                                                                                          |
| `tools/oxlint/unthrown.test.ts`                          | Every supplied rule rejects a deliberate violation in production and tests and accepts its valid form. A separate example preserves the known syntactic must-use gap.                                                               |
| Module checker                                           | Module shape, private imports, and lib dependency direction. Lib needs no interface object.                                                                                                                                         |
| `scripts/prove-module-boundaries.ts`                     | Valid module-to-lib and lib-to-lib imports pass all selected checks. Seventeen deliberate violations include private imports, lib-to-application references, real module and lib cycles, and lib lint, formatting, and type errors. |

Oxlint's `import/no-cycle` replaces the former cycle tool and its configuration.
No second dependency-analysis tool remains.
The effective Oxlint configuration was checked for the rejected rules from #201.
It enables none of them.
Raw environment ownership remains with #239, and #219's unknown and typeof policy is not adopted here.
Ordinary boundary narrowing and filter/map pipelines remain valid.

The first four anti-slop rules retain their MIT upstream license and provenance.
The other custom rules were written locally from the approved behavior requirements.
No private company source or text was copied.

## Exception and defect boundaries

Only `typescript/no-unsafe-type-assertion`, `typescript/await-thenable`, and `typescript/unbound-method` are off in `*.test.ts`.
The unsafe-data and unthrown additions have no blanket test exception.
A typed expected publication object uses a narrow string assertion for Bun's asymmetric matcher under the existing assertion exception.
External JSON in production, test processes, and controlled tools now passes through schemas rather than unsafe typed assignments.
Server shutdown owners await completion instead of passing async work to a void contract.

One line-specific `unthrown/no-throw` exception preserves unexpected I/O defects in the release inventory scanner.
Only ENOENT means an empty inventory.
The beside-test passes a file where a directory is required, observes ENOTDIR, and checks that the file remains unchanged.
Converting every I/O error to an empty inventory would hide a defect and allow a misleading artifact.
There is no file or directory exclusion for this exception.

Release tooling uses invariant assertions for missing build documentation, an invalid retained release record, and an unrepresentable tar path.
These checks still fail rather than produce a successful or empty artifact.
They do not model a new workflow failure or grant a retry.
This slice does not convert the retained release APIs into a new Result framework.
Future workflow owners must apply ADR-0019 at their own operation and command boundaries.

## Completed experiment removal

The person approved removal of both completed disposable prototype directories, including their comparison pages and tests, rather than many lint suppressions for deliberately prohibited forms.
The selected ordered-table architecture and unthrown contract remain in ADR-0003 and ADR-0019.
Historical state-machine evidence remains in the [implementation record](236-state-machine-prototypes.md) and commits `662d7d8` and `3421d86`.
The Result comparison and its selected contract remain in [#261](https://github.com/fveracoechea/operator/issues/261#issuecomment-6397078608) and commit `b606a950969ca7a4dfaace5e243c2f5c2b724a49`.
Those experiments are no longer live commands in this checkout.

Agent instructions and the affected skills now name the separate cycle and structural owners and use public-interface or external-tool fakes instead of path-based module replacement.
The CLI remains help and version only.
No replacement workflow, real legacy state, host permission, merge, or release publication is part of this change.

## Verification

Verified on Linux with Bun 1.4.4.

| Command                                         | Observed result                                                                                                                                                   |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile`                 | Passed with no dependency or lock changes.                                                                                                                        |
| `bun outdated`                                  | No outdated root dependencies.                                                                                                                                    |
| `bun run format`                                | Passed.                                                                                                                                                           |
| `bun run test:timings`                          | Passed, 171 tests across 33 files. Removed the obsolete prototype entries that Bun retains when merging timing data.                                              |
| `bun run quality`                               | Passed formatting, lint, type checking, module and skill checks, all 171 tests, and rejection of all 17 deliberate boundary violations followed by a clean graph. |
| `bun run test --rerun-each=3`                   | Passed, 513 test executions across 33 files, with no observed flake. No retry option masked a failed test.                                                        |
| `bunx --bun --no-install oxlint --print-config` | Confirmed type-aware lint, separate type checking, the selected rules, narrow test exceptions, and no rejected #201 rule.                                         |
| `git diff --check`                              | Passed.                                                                                                                                                           |

The changed Markdown files also passed an explicit `oxfmt --check` invocation because the ordinary format script does not include those paths.
The final suite includes real source and controlled-registry installed CLI delivery and the release tooling's refusal checks.
The new exception tests initially used awaits that triggered other enabled rules.
The final examples isolate the intended test exception without weakening those rules.
Earlier formatting failures were corrected before the passing full runs.
No known failure or observed flake remains.

These results do not prove macOS or Nix delivery, live GitHub writes by the product, or any planned device-level workflow.
Those checks remain with their owning implementation tickets.
