# State-machine prototypes, issue 236

This is a decision package, not completion of #236.
The person asked to inspect both prototypes before choosing.
The ordered table is a recommendation only.
No ADR is changed, no architecture choice is recorded as approved, and no later ticket is started.

## Scope

Both disposable implementations live in `scripts/prototypes/state-machines/` on `global-operator-home`, after legacy removal at `313798a`.
Each implementation covers PR and report assignment completion and a separate review-request lifecycle.
The [experiment instructions](../../scripts/prototypes/state-machines/README.md) describe the call sites, scope limits, scratch invocation, result contract, and alternatives.
The GitHub comment on #236 contains the comparison, recommendation, and both prototypes.
The new OpenCode presentation task is limited to an HTML explanation for the person's decision.

The implementations share schemas, output constructors, effect-result interpretation, cases, and the outer command adapter.
They do not share transition selection or workflow guards.
The equality matrix compares 1,352 assignment decisions and 1,584 review decisions, plus guidance for the same state and fact combinations.
Independent expected-result cases cover guard order, invalid events, report authority, history preservation, merge conditions, review-event computation, head changes, round triggers, failures, retries, repeated results, interruption, and recovery.
Process cases use the experiment's consuming CLI with real Git, SQLite, explicit scratch roots, and a controlled external executable.
The production CLI remains help and version only.

No production module, root library, dependency, skill, public invocation, or durable architectural contract is added.
Artifact checks prove that the experiment is not in the release.
The only demonstrated library candidate is the small ordered first-match loop, not a compulsory state-machine engine.
Workflow rules and state ownership remain private to their owners.

## Verification

Verified on Linux with Bun 1.4.3.

| Command                                                                                                                                   | Observed result                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun test --isolate --timeout=30000 scripts/prototypes/state-machines/cli.test.ts --test-name-pattern rechecks` before correcting retries | Red, all six cases failed. Both designs retried a merge without new approval, retained an approval after CI failed, and retried against an old Git head.                                           |
| `bun test --isolate --timeout=30000 scripts/prototypes/state-machines` after the retry corrections                                        | Passed, 120 tests across 12 files.                                                                                                                                                                 |
| `bun run quality`                                                                                                                         | Passed, 237 tests across 35 files and all static checks. Module proof rejected all 14 deliberate structural violations and restored its clean graph.                                               |
| `bun scripts/prototypes/state-machines/prove-guards.ts`                                                                                   | Passed, 85 of 85 named deliberate breaks caused assertion failures in scratch copies. No delivery source was mutated. This is a bounded guard proof, not a mutation score or #238's mutation tool. |
| `bun run test modules/operator-release`                                                                                                   | Passed, 27 tests across six files, including real source and controlled-registry installed delivery.                                                                                               |
| `bun test --isolate --timeout=30000 --rerun-each=3 scripts/prototypes/state-machines`                                                     | Passed, 360 tests with no observed flake. No failed run was masked with retries.                                                                                                                   |
| `git diff --check`                                                                                                                        | Passed.                                                                                                                                                                                            |

Early checks found formatting, type-test fixture, and complexity errors.
They also found that the artifact-help test needed its runtime dependencies beside the scratch artifact, as in the existing release tests.
Those checks passed after correction.
The self-review then found and reproduced the stale-fact retry defects through the CLI before changing either implementation.
Both now reuse their original workflow guards on retry rather than copy those guards into another path.
The command `bun test --isolate --timeout=30000 scripts/prototypes/state-machines/cli.test.ts --test-name-pattern 'real Git head on retry'` also reproduced acceptance of an old result after a head-change retry, with two failing cases.
Review effect keys now distinguish the round, head-move count, and reviewed head, so an older result cannot complete the new post.

The process tests verify one committed transition and one external action for two competing starts.
They also verify that external work can acquire the database write lock, that refusal leaves database bytes and external actions unchanged, and that a new process reads a pending action after an injected exit.
Recovery of a confirmed applied action does not repeat it.
A missing external record leaves retry blocked, because absence is not evidence of non-application.

## Review and limits

The self-review checked placement, release exclusion, pure decisions, shared and private code, result correlation, transaction scope, prohibited effects after refusal, retry freshness, and the acceptance criteria.
No unresolved code finding remains from that review.
Human selection remains open and is not a code finding.

The prototypes are bounded examples, not full production implementations of the two workflows.
They do not prove live GitHub merge or post reconciliation, Herdr cleanup, Slack transport, either agent host, multi-record state, production Drizzle migrations, Nix, or macOS behavior.
Live external non-application evidence and the remaining race between observation and an external write still need verification in their owning production tickets.
No real Operator state or host permissions were read or changed.
No push, merge, release publication, new delivery PR, issue closure, or dependency change was performed.

The experiment is ready for the person's comparison, not for dependent production work.
After the person's choice, resolve any contradiction with ADR 0003 and record a qualifying durable decision before implementation proceeds.
