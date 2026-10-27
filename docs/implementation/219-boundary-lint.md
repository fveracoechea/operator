# Boundary lint rules, issue 219

## Delivered scope

`anti-slop/no-unknown-returns`, `no-object-parameters`, `no-runtime-typeof`, and `no-unknown-parameters` are errors across `cli.ts`, `modules`, `lib`, `scripts`, and `tools/oxlint`.
ADR-0018 records the contract that the person approved in the [decision amendment](https://github.com/fveracoechea/operator/issues/219#issuecomment-6400416605).
There is no file, directory, function-name, or disable-comment exception, and no violation baseline.

The rules derive from MIT upstream `dmmulroy/anti-slop` at `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`.
Operator replaces the upstream `cause` exemption and the any-predicate exemption with one shared eligibility check in `tools/oxlint/anti-slop/validator-subject.ts`.
Alias resolution uses the Oxlint scope manager, so a type parameter shadows a module alias without the upstream lexical type-parameter helper.
The eligibility check also uses the scope manager to find a reference to any enclosing type parameter in the predicate target.
That helper and its assertion chain and complexity findings are therefore not copied.

## Validator eligibility

A function is a validator when it has an explicit `value is T` annotation, no type parameters, and a plain parameter of that name annotated exactly `unknown`.
`asserts` predicates do not qualify.
Targets that resolve to `any`, `unknown`, `object`, `Object`, `{}`, `Record<K, unknown>` or `Record<K, any>`, a union with one of them, or an intersection of only broad members do not qualify.
A target that refers to a type parameter of an enclosing function, class, method, or type alias does not qualify, because the predicate is then generic.
Only that subject receives the unknown-parameter exception.
Runtime `typeof` may check the subject or a member chain rooted in its binding, and only in the validator itself.
The binding is matched through its scope definition, so an alias, a shadowing parameter, or a nested callback does not match.
`typeof` compared with `"undefined"` stays legal as an existence probe, and type-position `typeof` stays legal.

## Resurvey and fixes

The first lint run after #237 reported 85 findings: 46 unknown parameters, 20 object parameters, 14 runtime `typeof` checks, and 5 unknown returns.
All are fixed in place:

- Every unthrown qualification helper takes `Error`, and each `fromPromise` or `fromThrowable` call narrows the caught value inline with `instanceof Error` before it calls the helper.
  This is a style choice, not a lint constraint: ADR-0019 asks for direct unthrown use, and the person's opinions prefer a one-line expression inline over a helper.
  A shared adapter that returns a contextually typed callback would also pass lint. The person decides if that shape is better.
- `lib/coded-error.ts` holds the one `isCodedError` validator that reads a runtime or SQLite error code.
  It replaces the `errorCode`, `isMissing`, and module-local `"code" in cause` checks.
- `lib/text-field.ts` is removed. GitHub and release readers run their schemas where the body arrives.
- Herdr, JSR, the release manifest, and the fake `gh` parse with a schema at the read.
  The PR answer schema runs in `readPullRequest`, and `pullRequestFacts` takes the parsed answer.
- Mutation selection discriminates `{ output }` and `{ name }` results from `{ error }` instead of with `typeof`.
- Tests name their override shapes and use `try` and `catch` or inferred callbacks instead of explicit `unknown` parameters.

Two behavior details changed.
A Herdr refusal now falls back to stderr when stdout is JSON without an error code.
A JSR error body whose `message` is not a string now reports the HTTP status instead of a coerced value.

## Skill topics

Every custom rule message ends with `See <skill>/<topic>.md.` through `tools/oxlint/skill-topic.ts`.
The development skill `.agents/skills/lint-fixes` holds four topics for the anti-slop and custom-tests rules.
`operator/env-through-schema` keeps its pointer to `deep-modules/server-state.md`.
`tools/oxlint/skill-topic.test.ts` reads the message of every rule in the three local plugins.
It checks that the topic exists, that the skill router links it, and that it names the rule.
Each `lint-fixes` section for a rule must also show the fix in a TypeScript example.

## Proof

| Test                                                   | Contract                                                                                                                                                                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools/oxlint/anti-slop/validator-subject.test.ts`     | Through the real lint command: valid subject and member checks, an object-method validator, schema-first parsing, existence probes, and type-position `typeof` pass.                                       |
|                                                        | Sibling unknown parameters, nested callbacks, alias and unrelated operands, module checks, generic predicates, enclosing type parameters, `asserts`, broad targets, broad dictionaries and intersections, non-unknown subjects, defaults, and validator types are rejected. |
|                                                        | A validator file still rejects `cause: unknown`, a `parse(value: unknown)` wrapper, an unknown return, and an `object` parameter.                                                                          |
| `tools/oxlint/anti-slop/no-unknown-returns.test.ts`    | Direct, promise, generic alias, union alias, and signature returns are rejected. Named and container results pass.                                                                                         |
| `tools/oxlint/anti-slop/no-object-parameters.test.ts`  | Direct, union, alias, and signature parameters are rejected. Named types, records, and a shadowing type parameter pass.                                                                                    |
| `tools/oxlint/anti-slop/no-runtime-typeof.test.ts`     | Runtime `typeof` outside a validator is rejected. Both existence probe orders and type-position `typeof` pass.                                                                                             |
| `tools/oxlint/anti-slop/no-unknown-parameters.test.ts` | Function, union, `cause`, method signature, and arrow parameters are rejected. Named inputs, `unknown[]`, and a validator subject pass.                                                                    |
| `tools/oxlint/skill-topic.test.ts`                     | Every custom rule message points to a linked topic that names the rule.                                                                                                                                    |
| `lib/coded-error.test.ts`                              | Only an `Error` with a string `code` is a coded error.                                                                                                                                                     |

Deliberate breaks: accepting generic validators fails the eligibility test, ignoring enclosing type parameters fails it, matching a subject by node type instead of its binding fails it, and removing a rule heading from a topic fails the pointer test.

## Verification

```sh
bun run lint
bun run typecheck
bun test tools/oxlint
bun run quality
```

`bun test tools/oxlint` passed 83 tests. `check.test.ts` needs the repository's 30-second test timeout, which `bun run test` supplies.
The full quality gate result is recorded in the commit that delivers this note.
