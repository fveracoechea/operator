# Recovery findings for #373

Recorded on 2026-11-20.
Related pages: [landing history](issue-373-landing.md), [scope](issue-373-scope.md), [user constraints](issue-373-user-constraints.md), [native delegation retro](issue-373-native-delegation-retro.md), [index](index.md).

## Landed #419 and draft #429 correction

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

## Qualification evidence limits

On 2026-11-20, the [local qualification decision](issue-373-user-constraints.md#local-qualification-decision-on-2026-11-20) retained independent review and passing complete local checks on the actual candidate.
At `fveracoechea/operator@7fd3cfb3532ab82f74cc6a4cefd87c3ce5afce98`, [`package.json`](https://github.com/fveracoechea/operator/blob/7fd3cfb3532ab82f74cc6a4cefd87c3ce5afce98/package.json#L29-L30) made full quality include the test suite; a duplicate full-suite campaign added no required gate.
The recovery reports above distinguished completed scoped passes from external 120-second tool timeouts and runs that overlapped source edits.
Neither an interrupted run nor tests against changing content established a final frozen-head pass.
A run begun before a later commit also did not qualify that later head.
Baseline failures established provenance, not permission to waive a red gate.

On 2026-11-20, the source reports cited here were local evidence pointers, not permanent public URLs or copied source records.
The ingest verified GitHub merge metadata and published PR heads; it did not independently rerun implementation tests or qualification campaigns.
This documentation-only update granted no ready, merge, close, review-post, deletion, real-state, runtime, or release authority.
