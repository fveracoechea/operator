# Errors-as-values experiment, issue 261

Disposable code for the person's library decision.
No option is selected, and no dependency is added to Operator.
The production CLI still supports help and version only.

Open [comparison.html](comparison.html) directly in a browser.
It is self-contained, has code snippets from the executable sources, and includes an interactive failure walkthrough, pros and cons, a recommendation, and evidence limits.
The walkthrough illustrates tested paths, but it does not run the libraries in the browser.
The person's preference for neverthrow is not approval of a production contract.

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
{"command":"step","workflow":"assignment","design":"neverthrow-promise","revision":0,"action":"merge","mode":"lost"}
JSON
bun "$scratch/results/cli.mts" "$root" <<'JSON'
{"command":"step","workflow":"assignment","design":"neverthrow-promise","revision":2,"action":"recover"}
JSON
```

The second command reports an uncertain outcome and exits with code 5.
The third reconciles controlled application evidence without repeating the merge.
The assignment is merged with cleanup still pending.
These are experiment commands, not working Operator workflow commands.

Choose `plain`, `neverthrow-promise`, `neverthrow-async`, `effect-value`, or `effect-runtime` as `design`.
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
  Production should use the chosen library directly, not retain all five adapters or a forwarding wrapper.
- `cli.mts` commits the owner's plan before it starts an external operation.
  It submits a correlated effect-result event afterward.
- `external.mts` is a controlled executable that writes scratch evidence only.
  It acquires the state database's write lock itself, so executing it while a write transaction remains open fails the CLI case.
- The same tests cover both owners and all five options.
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

## Recommendation, not selection

Use neverthrow Result values and default to ordinary `Promise<Result<T, E>>` for async contracts.
Use ResultAsync locally when the chain is clearer, especially `fromThrowable` at an external promise boundary.
The ordinary Promise implementation passes the same cases and needs no extra async abstraction.
Neverthrow's consistent composition API and the person's stated preference justify its small library cost over maintaining local combinators.
It does not provide stronger evidence, transaction, cancellation, or retry guarantees than the plain union.

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
No production must-use policy, second linter, #237 rule change, or #219 parser exemption is selected here.

`release.test.ts` checks the actual Operator artifact's exclusion of experiment code, the page, and candidate dependencies.
It also feeds minimal source roots with candidate root imports through the actual release builder and executes their ESM output with declarations present.
The generated JSR import map names the exact package pins.
The isolated Effect examples use subpath imports, so JSR subpath mapping still requires explicit verification before production use.
Using a root Effect import avoids that exact import-map question but is not proof of live JSR publication.

No live GitHub reconciliation, exactly-once guarantee, remote undo, production Drizzle behavior, JSR publication, Nix installation, macOS behavior, or scale benchmark is established.
No real legacy Operator state or host permissions are read or changed.
No later ticket, ADR selection, merge, or release follows from this experiment.

## Page maintenance

```sh
bun scripts/prototypes/results/build-page.ts
bun test scripts/prototypes/results/build-page.test.ts
```

Edit the template or executable source, then regenerate the page.
The page test rejects stale embedded code.
`browser-check.mjs` is an optional Playwright check of all five choices, uncertain recovery, absent evidence, and mobile overflow.
Supply an installed scratch Playwright module as its first argument.
It adds no root dependency and saves screenshots under `/tmp/opencode/operator-261-browser/`.
The comparison and approved decision, if any, belong on #261 before dependent production adoption.
