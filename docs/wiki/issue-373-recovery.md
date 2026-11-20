# Recovery findings for #373

Recorded on 2026-11-20.
Related pages: [landing history](issue-373-landing.md), [scope](issue-373-scope.md), [user constraints](issue-373-user-constraints.md), [native delegation retro](issue-373-native-delegation-retro.md), [index](index.md).

The [qualified recovery checkpoint](#qualified-recovery-checkpoint-on-2026-11-20) supersedes the old draft, fixture-blocker, and mutation-gate claims below.
The recorded red results remain evidence at their original heads.

## Landed #419 and draft #429 correction

The later [qualified #429 merge](#qualified-429-merge) supersedes this section's draft and pending-qualification status.
The earlier findings and scoped evidence remain dated history.

On 2026-11-20, GitHub verified [#419](https://github.com/fveracoechea/operator/pull/419) merged head `fveracoechea/operator@ec9279ee7ae2e5cf4685d53f38cea2ec7cf35d49` into main at `fveracoechea/operator@7fd3cfb3532ab82f74cc6a4cefd87c3ce5afce98`.
The merge's first parent was `fveracoechea/operator@3f40479dd188a53ef43d945bc04afa5cdd88eb30`.
This superseded the [earlier open-head observations](issue-373-landing.md#delivery-snapshots), not the spec's acceptance criteria.

On 2026-11-20, independent Spec review reproduced a custom-kind parity bug at that final #419 head.
An accepted PR-completion, pane-resource kind launched through a registered plan but failed one-off dispatch with `invalid_source_plan` and exit 2.
[Branch generation at `plan.ts:155`](https://github.com/fveracoechea/operator/blob/ec9279ee7ae2e5cf4685d53f38cea2ec7cf35d49/src/modules/work-sources/plan.ts#L155) handled worktree resources only; the stored PR schema also required branch metadata for pane resources.
Independent Standards review found that `ask.cli.test.ts` and `dispatch.cli.test.ts` forwarded whole suites instead of testing their private owners directly.
Those wrappers repeated 46 public scenarios and asserted fixed pass counts; the finding did not deny the existing public behavior coverage.
The sources were `/tmp/opencode/issue373-pr419-spec.md` and `/tmp/opencode/issue373-pr419-standards.md`.

On 2026-11-20, GitHub verified [#429](https://github.com/fveracoechea/operator/pull/429) open and draft, based on main, at `fveracoechea/operator@44d5bd3fc039e0315ac23b5a9fc285efefeb51aa`.
Its fixed base was `fveracoechea/operator@7fd3cfb3532ab82f74cc6a4cefd87c3ce5afce98`.
The candidate derived one-off branch metadata for PR completion and replaced the suite wrappers with direct private-owner tests.
It retained public workflow coverage and added a public custom-kind parity regression.
Its author reported 203 targeted tests, 40 killed changed-line mutants with no remaining mutation failures, and passing static quality at that candidate.
Independent Standards review found no actionable finding; it did not independently rerun those checks or establish a Spec verdict.
Spec review and final full-quality qualification remained pending in this handoff; no merged-fix claim followed from those scoped passes.
The sources were `/tmp/opencode/issue373-dispatch-test-correction.md` and `/tmp/opencode/issue373-pr429-standards.md`.

## Recovered #420 and unresolved review findings

The later [assembled #420 checkpoint](#assembled-420-and-test-only-qualification-corrections) supersedes this section's candidate and fix status.
The earlier review findings retain their original head and scope.

On 2026-11-20, GitHub verified [#420](https://github.com/fveracoechea/operator/pull/420) open and draft, targeting main at `fveracoechea/operator@f40c232cd4829fec54f3e7b0a587e021f77eb072`.
This superseded its earlier remote head `fveracoechea/operator@b14ddab5b1183be30a5ec89e529f3228bfe1f151` and dependency-only base.
The recovery retained all 28 unpublished local commits through preserved head `fveracoechea/operator@0ead329a6482ac3e627ab4578cca873a72a6d81b`.
It integrated main at `fveracoechea/operator@7fd3cfb3532ab82f74cc6a4cefd87c3ce5afce98` and published through a normal fast-forward push.
Its report recorded original worktrees, branches, and dirty files untouched.

On 2026-11-20, that #420 candidate corrected outgoing-worker authorization when its continuation encountered a corrupt recovery receipt.
That specific public regression returned `handoff_continuation_refused`, exit 4, before writes, pane closure, or launch.
Its preparation report retained unresolved continuation/target/migration-policy mutation findings and incomplete mutant executions as qualification blockers.
Scoped tests and static checks did not establish final-head full quality.
The source was `/tmp/opencode/issue373-pr420-evidence.md`.

On 2026-11-20, independent Standards review of `fveracoechea/operator@f40c232cd4829fec54f3e7b0a587e021f77eb072` reported two additional blockers:

- `pull-requests/internal-review.ts:243-257` converted continuation-operation Defects into ordinary `handoff_defect` failures, losing the original cause and command-boundary handling.
- The write-owning `device-state/internal-reviews.test.ts` and `launches.test.ts` did not supply continuations to test authorization wiring and supervision preservation directly.

On 2026-11-20, these were static review findings, not runtime reproductions or implemented fixes.
The source was `/tmp/opencode/issue373-pr420-standards.md`.

### Conditional bookkeeping finding and disposition

On 2026-11-20, independent Spec+Design review of `fveracoechea/operator@f40c232cd4829fec54f3e7b0a587e021f77eb072` reported 58 focused existing tests passing and no independent Design blocker.
Its separate probes found recovery-progress bookkeeping before refusal, but neither pane closure nor worker start.
The reviewer made its P2 conditional on whether the supplied "before effect" invariant prohibited coordination writes.
The source was `/tmp/opencode/issue373-pr420-spec-design.md`; the finding did not establish a destructive-step bypass.

On 2026-11-20, the chief decided that the stronger reviewer-prompt invariant did not amend the product spec.
[#388](https://github.com/fveracoechea/operator/issues/388) did not require write-free bookkeeping refusals.
At the reviewed candidate, [ADR-0033](https://github.com/fveracoechea/operator/blob/f40c232cd4829fec54f3e7b0a587e021f77eb072/docs/adr/0033-missing-review-recovery-records-its-authorization-as-steering.md) required revalidation before destructive steps, not all coordination writes.
The chief therefore treated the conditional write-free invariant as nonblocking unless a canonical source required it.
This disposition did not resolve the separate Standards blockers above.
The decision source was the supervising session's dated native delegation, not an invented spec amendment or public transcript.

On 2026-11-20, the same review observed "Nothing was changed" despite updated failure details and timestamps at that candidate.
The chief assigned verification against the refusal metadata contract to the Defect-fix owner.
This remained a possible false-refusal message, not a verified fix or an asserted destructive bug.

## Preserved downstream work

On 2026-11-20, the recovery reports recorded the following separate candidates and evidence limits.
None of these entries established a main landing or final integrated qualification.

- For [#389](https://github.com/fveracoechea/operator/issues/389), 129 synthetic tests passed at frozen `fveracoechea/operator@bdecf11416dc0d520a905f5366187be9df727746`.
  Those passes did not qualify a later integration candidate.
  A later same-date report recorded `fveracoechea/operator@54da94e5a01d89d8f101f3c081398dd5c5d6e60a` on the pinned #420 recovery parent, superseding its earlier parent-wait blocker only.
  Independent review, full quality, and mutation qualification remained separate requirements.
  The source was `/tmp/opencode/issue373-issue389-evidence.md`.
- For [#390](https://github.com/fveracoechea/operator/issues/390), the original six-file dirty patch remained at `/tmp/opencode/issue373-390-original.patch`.
  The ingest delegation recorded `fveracoechea/operator@cd98475b3e8784526598fce6de53b70f7405f845` with 261 direct/contract tests and passing scoped mutation, while public and integration checks remained pending.
  A later same-date report superseded that recovery head with `fveracoechea/operator@8421e0378f1c9867374bb3cb1c9686b177e474d4`, correcting public-test assertions without another production correction.
  That report recorded 126 owning-unit tests, 135 contract tests, 24 public parking tests, and two killed scoped mutants without survivors or incomplete results.
  The recovered safety checks refused unknown/incomplete checks, invalid pagination, and errored GraphQL observations without advancing parked progress.
  Original work stayed untouched; integrated-parent qualification remained required.
  The source was `/tmp/opencode/issue373-issue390-evidence.md`, supplementing the earlier supervising-session handoff.
- For [#391](https://github.com/fveracoechea/operator/issues/391), `fveracoechea/operator@9991cd026a123407b144cee1374f3a044a43e2d7` retained final historical-owner fencing, raw-JSON compare-and-swap, null-kind filling, and stored-fact mapping.
  Its 262 selected synthetic tests passed on the frozen recovery candidate, not the eventual integrated parent.
  Integration needed the scoped final patch, not an earlier feature-only commit or whole historical branch replay.
  The source was `/tmp/opencode/issue373-issue391-evidence.md`.
- For [#393](https://github.com/fveracoechea/operator/issues/393), `fveracoechea/operator@4de721fff26d9c381882d717c59e515a692733a2` was provisional ten-action target work on an old #390 baseline.
  Its 182 focused passes did not waive inherited formatting failures or wider candidate failures.
  It required the recovered parent and fresh integrated qualification, not publication as main behavior.
  The source was `/tmp/opencode/issue373-issue393-evidence.md`.
- For [#396](https://github.com/fveracoechea/operator/issues/396), `fveracoechea/operator@e0cfa2ff5fef0931efa1de813c20490f028c6a95` drafted target role routers and fixture gates only.
  Missing prerequisite help options and the unchanged production release inventory left six final content/inventory gates failing.
  Synthetic guide resolution did not prove actual installed-host loading, and the prose did not prove command prerequisites implemented.
  The source was `/tmp/opencode/issue373-issue396-evidence.md`.

## Qualified #429 merge

Supersession verified on 2026-11-20: [#429](https://github.com/fveracoechea/operator/pull/429) merged at 09:03:30 UTC, replacing its draft status and pending qualification above.
The tested candidate was `fveracoechea/operator@44d5bd3fc039e0315ac23b5a9fc285efefeb51aa` on base `fveracoechea/operator@7fd3cfb3532ab82f74cc6a4cefd87c3ce5afce98`.
The qualification report recorded `bun run quality` exit 0, all 3,992 tests passing, zero failures, and complete static quality.
It recorded clean independent Standards and Spec+Design reviews of that exact head/base.
GitHub verified main merge `fveracoechea/operator@0d19ea45d022183135c4121fa48ea6a29096b196`.
The report verified the merge's parents and equality with the tested candidate's tree, `bf61791c64238c18c5253fc177168ec92e144b33`.
The primary source was `/tmp/opencode/issue373-pr429-quality.md`, alongside the linked GitHub PR.
This qualified the #429 correction, not later descendants or the whole #373 spec.

## Assembled #420 and test-only qualification corrections

The later [blocked whole-candidate qualification](#blocked-420-whole-candidate-qualification) supersedes this section's pending-review observation, not its scoped receipts.

Supersession verified on 2026-11-20: draft [#420](https://github.com/fveracoechea/operator/pull/420) targeted main at `fveracoechea/operator@d9ed14c9bb9860132e7f1d26f6de406bd315a785`.
It retained assembled parent `fveracoechea/operator@3ac7e0aa1d022f78018d8d368916e0b7f89ec667` and integrated main `fveracoechea/operator@0d19ea45d022183135c4121fa48ea6a29096b196`.
That parent combined the continuation mutation correction, Defect preservation and direct write-owner tests, and #429's main changes.
Its public probe recorded `state.handoffClaimed: true` and actionable refusal metadata after corrupt-receipt bookkeeping, without pane closure, successor launch, or launch-row changes.
This superseded the possible false-refusal verification task above, without imposing a write-free bookkeeping requirement.

On 2026-11-20, the successor changed four test files only; its other tracked files matched the assembled parent.
The correction report recorded passing static quality and 63 tests across those four files, with zero failures.
These repaired migration-count fixtures, deliberate-break targeting, handoff-marker synchronization, and private executable-copy assumptions.
The primary sources were `/tmp/opencode/issue373-pr420-final-integration.md`, `/tmp/opencode/issue373-pr420-qualification-fixes.md`, and `/tmp/opencode/issue373-pr420-candidate.json`.

On 2026-11-20, the integration report retained earlier narrow mutation passes of 215 and 165 killed mutants across their stated correction scopes.
The latter total combined 151 state-owner and 14 PR-correction kills; the state-owner receipt also retained eight existing ignored mutants.
Those receipts did not qualify the corrected candidate or all 19 eligible changed units against its actual main merge-base.
The supervising delegation recorded final qualification and fresh independent reviews as active, with no completed final verdict supplied to this ingest.
GitHub still reported #420 open and draft, not merged.
No earlier scoped pass or green main result replaced its remaining final-head gates.

## Published downstream drafts and eight inherited failures

The later [readiness correction](#reviewed-and-corrected-430-readiness) and [fixture and child checkpoint](#fixture-corrections-and-additional-published-drafts) supersede the old #430 head and unresolved-fixture status below.

Supersession verified on 2026-11-20: GitHub reported the following open drafts, replacing the earlier unpublished or provisional delivery observations above.
Their reports recorded passing scoped tests and static checks, not final integrated acceptance.

- Readiness [#430](https://github.com/fveracoechea/operator/pull/430) named `fveracoechea/operator@7a257f28895d4d3922bc867ee3df0c2363b8f878`, based on #420's branch.
  Sources were `/tmp/opencode/issue373-issue389-candidate.json` and `/tmp/opencode/issue373-issue389-evidence.md`.
- Parking [#431](https://github.com/fveracoechea/operator/pull/431) named `fveracoechea/operator@f7e2c7ace55a095f0f3900a9dd700e004d5ce8e2`, based on #430's branch.
  Sources were `/tmp/opencode/issue373-issue390-integrated-candidate.json` and `/tmp/opencode/issue373-issue390-integrated-evidence.md`.
- Assignment actions [#432](https://github.com/fveracoechea/operator/pull/432) named `fveracoechea/operator@3c062c73150c102cc28332701572e4945f75e768`, based on #431's branch.
  Sources were `/tmp/opencode/issue373-issue393-integrated-candidate.json` and `/tmp/opencode/issue373-issue393-integrated-evidence.md`.

On 2026-11-20, #430 still integrated historical #420 parent `fveracoechea/operator@f40c232cd4829fec54f3e7b0a587e021f77eb072` and main `fveracoechea/operator@7fd3cfb3532ab82f74cc6a4cefd87c3ce5afce98`.
#431 and #432 inherited that older foundation; publication did not propagate the corrected #420 or qualified #429 merge.
Parent refresh, deliberate combination with #391, fresh review, full quality, and applicable mutation qualification remained pending.

On 2026-11-20, #432's report established eight distinct inherited fixture failures, with parent reproduction evidence.
They comprised two host owner-head mismatches, three delegated-run stories, internal-review-off ownership, reset ownership, and the source consumer's missing parked-observation callback.
This later inventory superseded #431's four-failure inventory as the known downstream blocker set, not as proof those earlier failures never occurred.
#393's explicit-column fixture had corrected the earlier positional PR insert.
The supervising delegation recorded an active parent-fixture fix owner; none of the eight failures was waived or declared fixed by this checkpoint.
The [combined acceptance owner](issue-373-user-constraints.md#combined-acceptance-ownership-on-2026-11-20) retained final cross-ticket verification.

## Blocked #420 whole-candidate qualification

On 2026-11-20, two fresh whole-candidate mutation campaigns selected all 19 eligible changed units against `fveracoechea/operator@0d19ea45d022183135c4121fa48ea6a29096b196`.
Neither campaign passed.
The final local test-only correction was `fveracoechea/operator@f2d86fba109866a84f419d6e98ace455e2cf7e4a`; published draft #420 still named `fveracoechea/operator@d9ed14c9bb9860132e7f1d26f6de406bd315a785`.
Its latest diagnostic inventory retained 27 survivors and one incomplete timeout across two units.
That inventory combined whole-campaign results with a later narrow reproof; it was not a fresh whole-candidate passing receipt.
The exact local head passed 169 focused tests and static quality, but full quality had not run.
The primary source was `/tmp/opencode/issue373-pr420-final-quality.md`.

On 2026-11-20, independent Spec+Design review passed published `fveracoechea/operator@d9ed14c9bb9860132e7f1d26f6de406bd315a785`, with 187 selected tests.
Standards review requested direct owning-unit coverage for remaining adapters and readers.
The newer local tests addressed that request but lacked fresh independent delta approval.
Neither verdict approved later production changes or waived mutation blockers.
Sources were `/tmp/opencode/issue373-pr420-final-spec-design.md` and `/tmp/opencode/issue373-pr420-final-standards.md`.

## Reviewed and corrected #430 readiness

On 2026-11-20, independent review of `fveracoechea/operator@7a257f28895d4d3922bc867ee3df0c2363b8f878` requested changes on both axes.
Spec+Design reproduced a P1 malformed-readiness merge authorization and a P2 bare-CR reviewer note that escaped its Markdown quote.
Standards found two owning-test gaps for skipped readiness and branch-mismatch refusal.
Sources were `/tmp/opencode/issue373-pr430-spec-design.md` and `/tmp/opencode/issue373-pr430-standards.md`.

On 2026-11-20, correction `fveracoechea/operator@1ac79368a6b0ed4eb59348ca537d160958cff8c5` fixed those four findings.
Owner reads validated readiness before effects with the shared decoder; note validation and quoting handled LF, CRLF, and bare CR.
Its report recorded 219 focused passes, static quality, 61 killed owning-guard mutants, and 28 killed correction-delta mutants.
Those narrow mutation passes did not supersede its earlier broader selection's 120 survivors or qualify the complete feature.
The source was `/tmp/opencode/issue373-pr430-owning-test-fix.md`.

Later on 2026-11-20, GitHub verified corrected draft [#430](https://github.com/fveracoechea/operator/pull/430) published at `fveracoechea/operator@dce10ebf63013d03c4e098caacca3b2f8df4ad56`.
It integrated immutable parent `fveracoechea/operator@f2d86fba109866a84f419d6e98ace455e2cf7e4a`, the correction, and the #389 fixture commits below.
Its report recorded 815 scoped tests and passing static quality on frozen content.
The parent-relative inventory selected 24 eligible feature units; their final integrated mutations had not run.
The candidate was not merge-qualified and still needed eventual parent production refresh, fresh review, complete mutations, and full quality.
The source was `/tmp/opencode/issue373-pr430-corrected-integration.md`.

## Fixture corrections and additional published drafts

On 2026-11-20, the fixture report corrected all eight inherited failures and the earlier positional insert on `fveracoechea/operator@7eff577269c9b554bb5b75fbbcef0f26e77fd84e`.
It recorded 215 focused passes and static quality, without changing production guards.
The source was `/tmp/opencode/issue373-stack-fixture-fixes.md`.
Its #389 commits, `fveracoechea/operator@493386fa054a1aa8139ac0436eedddf1550b3e20` and `fveracoechea/operator@94d4b8465a8d42469cdb821659313eb2b7dbaa7f`, were integrated into corrected #430.
Its #390 commits, `fveracoechea/operator@6dc0c962f51a44a3e90ef62739367f42add73b3e` and `fveracoechea/operator@7eff577269c9b554bb5b75fbbcef0f26e77fd84e`, belonged on refreshed #431.
This superseded the earlier unresolved-fixture observation, not the need to refresh and qualify every descendant.
The combined correction branch's passes did not qualify the future refreshed stack.

On 2026-11-20, GitHub also verified these open drafts, not main landings:

- Migration [#434](https://github.com/fveracoechea/operator/pull/434) named `fveracoechea/operator@f6a2399882decd09c2bbeaf3e06892ac4e5ee15d`, based on #431's old head.
  Its report retained fact-only migration, null-kind filling, historical-owner fencing, and raw-JSON compare-and-swap.
  The source was `/tmp/opencode/issue373-issue391-integrated-evidence.md`.
- Adoption [#433](https://github.com/fveracoechea/operator/pull/433) named `fveracoechea/operator@dafdd723905da907afef525274d8822736e120c5`, based on #430's old head.
  Its 400 scoped passes and static quality excluded a separately recorded inherited fixture failure, not the requirement to correct it.
  The source was `/tmp/opencode/issue373-issue395-integrated-evidence.md`.

On 2026-11-20, the supervising delegation recorded child refresh work as unfinished; not all children contained corrected #430 or the fixture fixes.
Migration-origin readiness still needed reconciliation with #430's shared validated schema, without restoring unchecked non-null merge authorization.
Latest verified main remained `fveracoechea/operator@0d19ea45d022183135c4121fa48ea6a29096b196`, with #429's 3,992-test full-quality receipt.
The [combined acceptance owner](issue-373-user-constraints.md#combined-acceptance-ownership-on-2026-11-20) still owed final cross-ticket proof.

## Qualification evidence limits

On 2026-11-20, the [local qualification decision](issue-373-user-constraints.md#local-qualification-decision-on-2026-11-20) retained independent review and passing complete local checks on the actual candidate.
At `fveracoechea/operator@7fd3cfb3532ab82f74cc6a4cefd87c3ce5afce98`, [`package.json`](https://github.com/fveracoechea/operator/blob/7fd3cfb3532ab82f74cc6a4cefd87c3ce5afce98/package.json#L29-L30) made full quality include the test suite; a duplicate full-suite campaign added no required gate.
The recovery reports above distinguished completed scoped passes from external 120-second tool timeouts and runs that overlapped source edits.
Neither an interrupted run nor tests against changing content established a final frozen-head pass.
A run begun before a later commit also did not qualify that later head.
Baseline failures established provenance, not permission to waive a red gate.

Later on 2026-11-20, the chief pursued the [batch retro's external qualification runner](issue-373-native-delegation-retro.md#batch-retro-and-external-qualification-runner).
Its synthetic validation did not qualify any application candidate or retroactively change earlier receipts' contracts.

On 2026-11-20, the source reports cited here were local evidence pointers, not permanent public URLs or copied source records.
The ingest verified GitHub merge metadata and published PR heads; it did not independently rerun implementation tests or qualification campaigns.
This documentation-only update granted no ready, merge, close, review-post, deletion, real-state, runtime, or release authority.

## Qualified recovery checkpoint on 2026-11-20

On 2026-11-20, the [actual main chain](issue-373-landing.md#qualified-main-chain-on-2026-11-20) superseded the drafts and stale-parent observations above.
The final landing reports retain the independent review dispositions, observed failures, narrow corrections, and exact tested-tree proofs.
The eight inherited fixture failures no longer remained open blockers.
Later final qualification also corrected historical-schema teardown, explicit null-kind expectations, dispatch help, direct-adoption composition, and stale deliberate-break probes.
The corrections preserved meaningful assertions and production safety checks; inherited provenance was never a waiver.

On 2026-11-20, the person's final qualification policy retained independent reviews and full local quality, but made mutation diagnostics non-gating.
The earlier mutation-blocker language above described a superseded process checkpoint.
#420's 27 diagnostic survivors and one incomplete timeout remain unfinished diagnostics, not a clean mutation result.
Later full-quality passes do not change those diagnostic outcomes.
No new mutation campaign is required for this final integration.

On 2026-11-20, #396's inventory correction `aa290bdc931f9627741c66989ed59e554f05f6f8` superseded its original sixth content failure.
Its prior scoped artifact and mutation evidence is recorded in `/tmp/opencode/issue373-issue396-inventory-fix.md`.
The remaining five help-option failures were actual failing assertions on the old provisional parent, not five defects on the final parent.
Existing #428 retains those assertions against the integrated command implementations.
Final focused and full-quality receipts remain obligations of its immutable final candidate, not results implied by this historical update.
Synthetic both-host resolution proves path selection and missing-skill behavior, not installed-host invocation.
