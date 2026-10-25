# Errors-as-values experiment, issue 261

Disposable evidence for the person's approved unthrown decision in [ADR-0019](../../../docs/adr/0019-unthrown-separates-operational-failures-from-defects.md).
Unthrown is selected, but no production dependency is installed by this experiment.
The production CLI still supports help and version only.

Open [comparison.html](comparison.html) directly in a browser.
It is self-contained, has code snippets from the executable sources, and includes an interactive failure walkthrough, pros and cons, a recommendation, and evidence limits.
The walkthrough illustrates tested paths, but it does not run the libraries in the browser.
The person selected unthrown core, all nine supplied Oxlint rules including opt-in rules, and no unthrown Drizzle or Zod and Standard Schema integrations.
Production lint adoption belongs to #237, not this decision record.

## Run

```sh
bun scripts/prototypes/results/verify.ts
bun scripts/prototypes/results/prove-guards.ts
bun test --isolate --timeout=120000 scripts/prototypes/results
bun run quality
```

`verify.ts` creates a new `/tmp/opencode/operator-261-comparison-*` directory.
It copies these files and the selected #236 tables into that directory, then performs a frozen, script-free install using the experiment's separate manifest and lock.
It checks TypeScript with dependency declaration checking enabled, emits declarations, runs identical tests, executes each minified Bun ESM bundle, and proves the limits of scratch lint settings.
It prints the scratch path, exact commands, test summary, bundle measurements, and lint observations.
No package is installed into the checkout, a personal installation, or real Operator home.

The `.mts` experiment files have a separate dependency context.
The ordinary root TypeScript configuration covers the `.ts` launchers, not those `.mts` sources.
The root `comparison.test.ts` runs their strict scratch type check and tests as part of the existing quality command.
Formatting and linting cover the experimental source files through the existing `scripts` target.
The files named `*.cases.mts` are beside-test sources that the launcher copies to test-runner entry names in scratch.
This prevents normal test discovery from importing unapproved dependencies into the root project.

To try the consuming prototype CLI:

```sh
scratch=$(bun scripts/prototypes/results/prepare.ts)
root=$(mktemp -d /tmp/opencode/operator-261-run-XXXXXX)
bun "$scratch/results/cli.mts" "$root" <<'JSON'
{"command":"init","workflow":"assignment"}
JSON
bun "$scratch/results/cli.mts" "$root" <<'JSON'
{"command":"step","workflow":"assignment","design":"unthrown","revision":0,"action":"merge","mode":"lost"}
JSON
bun "$scratch/results/cli.mts" "$root" <<'JSON'
{"command":"step","workflow":"assignment","design":"unthrown","revision":2,"action":"recover"}
JSON
```

The second command reports an uncertain outcome and exits with code 5.
The third reconciles controlled application evidence without repeating the merge.
The assignment is merged with cleanup still pending.
These are experiment commands, not working Operator workflow commands.

Choose `plain`, `neverthrow-promise`, `neverthrow-async`, `effect-value`, `effect-runtime`, or `unthrown` as `design`.
Use `workflow: "review"` and `action: "draft"` for the review owner.
`init` creates a scratch Git repository for that workflow.
The root must be an existing real directory named `/tmp/opencode/operator-261-run-*`.
No default state path exists.

## What is held constant

- `assignment.mts` and `review.mts` call #236's selected ordered tables.
  They do not copy or replace workflow policy.
- `model.mts` holds this experiment's wire decoder and closed operational error union.
  These errors are not a proposed global registry.
- Each candidate has a native operation contract.
  A small `execute` projection presents the same plain test interface to the consuming CLI.
  Production should use the chosen library directly, not retain all six adapters or a forwarding wrapper.
- `cli.mts` commits the owner's plan before it starts an external operation.
  It submits a correlated effect-result event afterward.
- `external.mts` is a controlled executable that writes scratch evidence only.
  It acquires the state database's write lock itself, so executing it while a write transaction remains open fails the CLI case.
- The same tests cover both owners and all six options.
  They assert JSON results, exit codes, durable states through `show`, and controlled external actions.
  No module-path mocking is used.

The experiment represents one owner record per scratch root.
Its effect keys are local to that record.
Production correlation must also identify the owning record.
The prototype covers merge and review posting, not complete cleanup, dispatch, draft validation, or multi-record coordination.

## Contract under comparison

Workflow refusal is a closed owner result with no state or external change.
Expected external failures have closed variants with useful fields, not generic Error or string payloads.
The foreign-call boundary translates third-party synchronous throws and promise rejections conservatively into unknown external evidence.
Our own projection callbacks remain outside those catches, so defects reach the outer CLI exception boundary.
The outer boundary reports a defect, logs its exception and cause, and leaves the pending obligation intact.

Tool failure, invalid response, timeout, or cancellation does not prove non-application.
A controlled terminal rejection establishes non-application because its executable has finished and no request remains in flight.
This is evidence supplied by the fixture, not an assumption about a live service.
An empty evidence lookup stays unknown.
Recovery never grants an automatic retry.
An explicit retry requires established non-application and rechecks current owner guards.
The review retry reads the real scratch Git head, rechecks draft validity, and uses current CI facts.
The owner rejects old result keys after a new attempt.
Malformed recovery JSON returns a typed uncertain failure with diagnostics.
It changes no owner state and grants no retry.
Use `observationMode: "invalid-json"` with `action: "recover"` to exercise that fixture failure.

No class instance, runtime description, or Error object is persisted.
Only plain workflow state and controlled evidence cross the SQLite boundary.
Diagnostics carry name and message, process errors carry exit code and stderr, and applied responses carry a reference.
The command owns public JSON formatting and exit status.
It follows the surviving schemaVersion, operation, outcome, reason, blockers, and data convention without restoring removed request-replay protocols.

The transaction adapter forces a rollback when work returns a failure value.
It uses a private token solely to cross SQLite's throw-based rollback boundary.
Unknown exceptions still propagate.
This is a bounded raw SQLite demonstration, not adoption of a production schema or proof of Drizzle's integration.

## Approved selection

The person selected unthrown core Result and AsyncResult after inspecting this comparison.
The demonstrated core and lint plugin pin is 5.12.1.
This replaces the earlier agent-only recommendation and neverthrow preference.
The same CLI cases pass, callback defects stay separate from modeled errors, and its Oxlint plugin supplies tested diagnostics without an Effect scheduler.
Its core has no runtime dependencies.
The costs are a third Result state, eager async construction, an exhaustive matcher vocabulary, and incomplete syntactic enforcement.
Not-Ok does not imply Err.
Use plain error payloads without requiring TaggedError classes.
The shared adapter rethrows a Defect's original cause to the existing outer CLI exception handler.

Neverthrow with ordinary `Promise<Result<T, E>>` remains a strong alternative for a simpler two-state contract and native async/await.
Native Promise passes the same cases and is sufficient for that option.
Unthrown's AsyncResult adds a non-rejecting internal callback/defect contract, not stronger evidence, transaction, cancellation, or retry guarantees.
The edge's match handlers can still throw or reject.
The person also selected every supplied Oxlint rule, including all opt-in rules, and rejected unthrown's Drizzle and Zod and Standard Schema integrations.
Use core fromPromise thunks for async database calls and helpers, with qualification into modeled failures or defects.
Synchronous work can use fromThrowable, and SQLite write transactions must remain synchronous.
Returning Err or Defect after a write must roll back through the state owner's transaction policy.

The plain union remains a valid dependency-free alternative.
Do not turn it into a homemade general Result library.
Effect's lightweight Result remains distinct from its runtime.
Effect 4 renamed the value type that older v3 material calls Either.
There is no demonstrated need here for Effect's service requirements, scopes, schedules, or fiber model as a production default.
The runtime remains the option to reconsider when concrete concurrent or resource-owning callers need those capabilities.

Neverthrow 8.2.0 declares an optional native Rollup dependency.
The Result implementation does not import it, but a Linux installation can still install it.
Effect 4.0.6 has no runtime package dependencies but a much larger published package.
Bundle output is measured for the same decoder and adapters, not for minimum library imports or final Operator startup performance.

Only the small plain Result type and its constructors have demonstrated a possible root `lib/result.ts` placement.
With a library, import it directly instead.
Keep workflow errors, refusals, evidence, recovery rules, and result-event interpretation with their owners.
Transaction policy belongs to the state capability.
Reject a generic state-machine engine, global error registry, and broad catch-and-retry helper.

## Enforcement and compatibility limits

`lint-proof.mts` runs isolated assessment settings with Oxlint 1.87.0 and oxlint-tsgolint 7.0.2003.
It rejects floating promises, floating thenables, and direct unsafe extraction.
It proves that a synchronous ignored Result and an awaited-but-discarded Result still pass.
The direct method restriction is syntactic and does not prove alias analysis.
Neverthrow's documented ESLint plugin needs TypeScript parser services that Oxlint's JavaScript plugin API does not expose.
The approved addition to #237 is every supplied unthrown Oxlint rule as an error.
No second linter, new custom must-use rule, or #219 parser exemption is selected.

`unthrown-lint.mts` checks published @unthrown/oxlint 5.12.1 with Oxlint 1.83.0 and 1.87.0.
The former matches Operator's current pin, while the latter is this comparison's type-aware pin.
Each version rejects 12 deliberate violations across all nine rules and accepts each when the tested rule is disabled.
The full recommended preset accepts a valid exhaustive handler.
Six gaps still pass, including imported producers, dropped chains, unused bound Results, unannotated local producers, and an alias to Error.
Type-aware no-floating-promises also misses the dropped AsyncResult chain because its then method has no rejection callback.
Diagnostics name a repair but do not include an Operator skill-topic pointer.
The complete approved rule list is:

- `unthrown/no-ambiguous-error-type`
- `unthrown/no-async-result-race`
- `unthrown/no-catch-all-pattern`
- `unthrown/no-unhandled-result`
- `unthrown/no-unused-matcher`
- `unthrown/prefer-async-result`
- `unthrown/no-get-or-throw`
- `unthrown/no-throw`
- `unthrown/prefer-pre-lifted`

The last three are upstream opt-in rules and are explicitly selected too.
The implementation must reconcile deliberate exception boundaries under the enabled no-throw policy, not silently disable it.
Future plugin upgrades remain reviewed exact-pin changes, not automatic approval of new upstream rules.

## Integration evidence and limits

These integration examples remain comparison evidence only.
The person rejected both integration packages for production use.
This does not reject Drizzle itself or Zod itself.

`unthrown.cases.mts` uses Bun's built-in assertions and narrowing guards.
No Vitest dependency or Bun matcher framework is needed.
It checks native defects, promise-thunk qualification, eager construction, and @unthrown/standard-schema 5.12.1 with Zod 4.6.5.
The schema bridge preserves transformed output inference and validation issue paths.
It supports valid sync and async Zod validation and captures custom throwing or rejecting Standard Schema validators.
A throwing synchronous Zod transform takes Zod's async fallback.
The sync bridge then throws its documented usage error, and the async bridge captures the defect.

A throwing async Zod transform leaks an unhandled rejection from Zod's initial synchronous probe.
A child process prints Defect and then exits 1.
Direct Zod Standard Schema validation has the same leak without unthrown.
The subprocess test proves this limit rather than suppressing the rejection or claiming complete compatibility.
That validator path is blocked for adoption until corrected upstream or avoided by an explicitly tested boundary.
This comparison does not repair third-party code.

`drizzle.cases.mjs` runs a separate runtime-only dialect assessment with @unthrown/drizzle 0.3.0, Drizzle 1.0.0-rc.5-5935859, and pg 8.23.1.
The published package exports node-postgres, not bun-sqlite, and requires Drizzle ^1.0.0-rc.5-0 and pg ^8.16.0.
It replaces Postgres database/query classes rather than wrapping all Drizzle drivers.
The test loads its Postgres entry and rejects a missing SQLite entry.
It does not start a Postgres server, prove Postgres rollback, or claim Drizzle declaration compatibility.
The prerelease dependency is an experiment pin only.

Real in-memory Drizzle SQLite transactions commit when their callbacks return unthrown Err or Defect values.
An owner-private rollback token can roll back both channels.
Disabling that check fails the deliberate-break proof.
Operator's SQLite decision remains fixed, so the Postgres integration is not a ready-made production benefit.
This is an isolated example, not a new state module or a global transaction framework.

Primary source inspection used unthrown commit `0d5de7f2cac799987c2c24734ae4216f227f4bc0`, including all four examples and the core, lint, schema, Drizzle, and Vitest packages.
Executable checks use the published package pins, whose dependency ranges can differ from main.
The HTML page links those sources and registry metadata.

`release.test.ts` checks the actual Operator artifact's exclusion of experiment code, the page, and candidate dependencies.
It also feeds minimal source roots with candidate root imports through the actual release builder and executes their ESM output with declarations present.
The generated JSR import map names the exact package pins.
The isolated Effect examples use subpath imports, so JSR subpath mapping still requires explicit verification before production use.
Using a root Effect import avoids that exact import-map question but is not proof of live JSR publication.

No live GitHub reconciliation, exactly-once guarantee, remote undo, production Drizzle behavior, JSR publication, Nix installation, macOS behavior, or scale benchmark is established.
No real legacy Operator state or host permissions are read or changed.
ADR-0019 records the approved selection.
No implementation of a later ticket, merge, or release follows from this decision-record update.

## Page maintenance

```sh
bun scripts/prototypes/results/build-page.ts
bun test scripts/prototypes/results/build-page.test.ts
```

Edit the template or executable source, then regenerate the page.
The page test rejects stale embedded code.
`browser-check.mjs` is an optional Playwright check of all six choices, uncertain recovery, absent evidence, and mobile overflow.
Supply an installed scratch Playwright module as its first argument.
It adds no root dependency and saves screenshots under `/tmp/opencode/operator-261-browser/`.
The comparison and approved decision belong on #261 before dependent production adoption.
