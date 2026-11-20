# Worker-kind spec history

Recorded on 2026-11-20 for [spec #373](https://github.com/fveracoechea/operator/issues/373).
Related pages: [landing history](issue-373-landing.md), [user constraints](issue-373-user-constraints.md), [index](index.md).

## Planning authority

On 2026-11-13, [map #347](https://github.com/fveracoechea/operator/issues/347) scoped its destination to a spec, not implementation.
Its baseline and explicit amendments together recorded the planning decisions.
[Amendment 1](https://github.com/fveracoechea/operator/issues/347#issuecomment-6846664662) adopted the [approved amendment and recovery rules](https://github.com/fveracoechea/operator/issues/14#issuecomment-5729327792).
On 2026-11-13, the [destination comment](https://github.com/fveracoechea/operator/issues/347#issuecomment-6857437712) identified #373 as the spec through amendment 27.

On 2026-11-13, [amendment 6](https://github.com/fveracoechea/operator/issues/347#issuecomment-6848923204) distinguished delegated SuperAgent decisions from human answers.
It allowed a three-call read-only quick look before delegation through `operator ask` in the proposed workflow.
The [2026-11-20 task-specific tooling constraint](issue-373-user-constraints.md#delegated-user-decisions-on-2026-11-20) instead required native subagents and Git/`gh` for this completion effort.
That task instruction did not amend the product spec.

## Decisions and superseded proposals

- On 2026-11-13, [amendment 5](https://github.com/fveracoechea/operator/issues/347#issuecomment-6848432924) proposed `--completion` for one-off dispatch.
  Superseded that day by [amendment 7](https://github.com/fveracoechea/operator/issues/347#issuecomment-6848986892), which chose `--kind` and a kind-fixed completion type.
- On 2026-11-13, amendment 7 proposed migration-only `general` records.
  Superseded that day by [amendment 24](https://github.com/fveracoechea/operator/issues/347#issuecomment-6856483938), which chose null kinds and a bounded future fill path.
- On 2026-11-13, [amendment 11](https://github.com/fveracoechea/operator/issues/347#issuecomment-6849175850) gave `pr-feedback` no incoming note.
  [Amendment 26](https://github.com/fveracoechea/operator/issues/347#issuecomment-6857209482) retained that boundary while referring the question to the person.
  Superseded that day by the person's answer in [amendment 27](https://github.com/fveracoechea/operator/issues/347#issuecomment-6857428804): only review to `pr-feedback` gets that handoff note.
  Implementation to review remained note-free to protect the fresh reviewer.
- On 2026-11-13, [amendment 25](https://github.com/fveracoechea/operator/issues/347#issuecomment-6857202838) corrected adoption and wait proposals against the intervening ADRs.
  An adopted ready PR received no internal review; `operator ask` became the answer preset of one-off dispatch.

## Scope recorded on 2026-11-20

On 2026-11-20, #373 specified kinds on one assignment model, generic kind handoffs, and fresh PR-feedback launches with quiet-PR parking.
It also specified one-off dispatch, adoption, lifecycle ending, ten assignment actions, three event-driven waits, text input, and shorter guides and briefs.
These were spec claims, not a claim that every feature had landed; see the [delivery snapshots](issue-373-landing.md#delivery-snapshots).

On 2026-11-20, [independent review of landed #419](issue-373-recovery.md#landed-419-and-draft-429-correction) found incomplete custom-kind parity at `fveracoechea/operator@ec9279ee7ae2e5cf4685d53f38cea2ec7cf35d49`.
Its accepted custom PR/pane kind worked through a plan but failed through one-off dispatch.
The finding concerned #387's existing kind support, not a new spec requirement or #395 adoption.
On that date, [the downstream recovery record](issue-373-recovery.md#preserved-downstream-work) distinguished provisional #393/#396 target work from main behavior and full #373 completion.

On 2026-11-20, the chief [assessed #420's conditional bookkeeping finding](issue-373-recovery.md#conditional-bookkeeping-finding-and-disposition) against canonical #388 and ADR-0033 at `fveracoechea/operator@f40c232cd4829fec54f3e7b0a587e021f77eb072`.
The reviewer prompt's stronger "before effect" wording did not amend the product's destructive-step requirement.
The possible "Nothing was changed" metadata mismatch remained a separate verification task.

On 2026-11-20, #373 excluded domain-specific kind definitions, a review-sweep command, and the later release that removes null-kind filling.
It also excluded the unrelated cancelled-CI-job review-post bug from #349.
On 2026-11-17, [#422](https://github.com/fveracoechea/operator/issues/422) recorded separately approved open-parent refresh and managed multiple-parent stacks as a prerequisite.
Its approval did not authorize runtime activation or waive merge gates; see [landing history](issue-373-landing.md#merge-hold-and-422).

## Final acceptance scope checkpoint on 2026-11-20

On 2026-11-20, the read-only planner `/tmp/opencode/issue373-final-acceptance-map.md` mapped all 23 children to requirements, delivery pointers, and observable acceptance checks.
It found no missing feature ticket among canonical [#373](https://github.com/fveracoechea/operator/issues/373) requirements and [#347](https://github.com/fveracoechea/operator/issues/347) amendments through 27.
Cross-ticket proof remained pending; closed children and published drafts did not establish complete acceptance.
The [chief-of-staff retained ownership](issue-373-user-constraints.md#combined-acceptance-ownership-on-2026-11-20) of that proof and the future fresh verifier.

On 2026-11-20, the planner found no canonical #373 requirement or native child dependency requiring active [#422](https://github.com/fveracoechea/operator/issues/422)/[#423](https://github.com/fveracoechea/operator/pull/423) managed-stack behavior.
The demonstrated technical dependency was inherited inactive stack storage and lease protection, not active refresh or multiple-parent operations.
This clarified the earlier prerequisite wording above without cancelling the separately approved #422 work.
Any newly discovered active API dependency still required proof before integration.
[#414](https://github.com/fveracoechea/operator/issues/414), [#415](https://github.com/fveracoechea/operator/issues/415), and version/release [#398](https://github.com/fveracoechea/operator/pull/398) remained outside this completion effort.
No runtime activation or publication followed from this scope assessment.

On 2026-11-20, the planner's #420 pointer named `fveracoechea/operator@3ac7e0aa1d022f78018d8d368916e0b7f89ec667`.
The [later recovery checkpoint](issue-373-recovery.md#assembled-420-and-test-only-qualification-corrections) superseded that pointer with the test-only corrected draft, not a final qualification pass.
The [qualified #429 merge](issue-373-recovery.md#qualified-429-merge) also superseded its earlier draft correction status and resolved the recorded custom-kind parity finding.
The [downstream checkpoint](issue-373-recovery.md#published-downstream-drafts-and-eight-inherited-failures) supplied published #432 and the larger inherited-failure inventory after the planner's provisional observations.
The planner remained a dated source, not a second live status ledger.

Later on 2026-11-20, the [#420 qualification report](issue-373-recovery.md#blocked-420-whole-candidate-qualification) established whole-candidate mutation blockers, not an expanded feature requirement or passing final gate.
The [#430 correction](issue-373-recovery.md#reviewed-and-corrected-430-readiness) enforced existing readiness and note boundaries; it did not amend canonical #373 scope.
The [fixture corrections and published #433/#434 drafts](issue-373-recovery.md#fixture-corrections-and-additional-published-drafts) advanced integration evidence without completing combined acceptance.
Migration-origin readiness still needed compatibility proof with the corrected shared decoder before the stack could claim acceptance.
The [external qualification runner](issue-373-native-delegation-retro.md#batch-retro-and-external-qualification-runner) remained local evidence tooling, not a new product feature, CI requirement, or global-instruction change.

## Architecture references at the documentation base

On 2026-11-20, `fveracoechea/operator@3f40479` contained the following decision records.
These commit-pinned documents, rather than this wiki, supplied the architecture detail:

- [ADR-0029](https://github.com/fveracoechea/operator/blob/3f40479dd188a53ef43d945bc04afa5cdd88eb30/docs/adr/0029-worker-kinds-sit-on-one-assignment-model.md) recorded one assignment model, kind snapshots, the shared phase machine, and the two-return report limit.
- [ADR-0010](https://github.com/fveracoechea/operator/blob/3f40479dd188a53ef43d945bc04afa5cdd88eb30/docs/adr/0010-pr-assignments-own-their-feedback-loop-and-merge.md) recorded PR ownership and the pre-#422 one-open-parent restriction.
- [ADR-0020](https://github.com/fveracoechea/operator/blob/3f40479dd188a53ef43d945bc04afa5cdd88eb30/docs/adr/0020-a-fresh-reviewer-takes-over-a-draft-pr-before-it-is-ready.md) recorded fresh review and review gates, with later #373 changes specified separately.
- [ADR-0031](https://github.com/fveracoechea/operator/blob/3f40479dd188a53ef43d945bc04afa5cdd88eb30/docs/adr/0031-every-cli-result-names-its-next-step.md) recorded explicit next steps on results and refusals.

On 2026-11-20, this documentation task changed neither these ADRs nor `CONTEXT.md`.
The wiki recorded the spec/implementation distinction rather than silently reconciling their remaining differences.

## Final role-package checkpoint on 2026-11-20

On 2026-11-20, `/tmp/opencode/issue373-final-acceptance-ledger-pre-final.md` audited all 23 children against immutable #432 main `bb3e05fafe0ed854c31fa8778893df03a71694ef`.
It demonstrated 20 landed child deliveries and assigned the remaining #392/#394/#396 packages to existing #435/#436/#428.
The [later actual chain](issue-373-landing.md#qualified-main-chain-on-2026-11-20) records #435 and #436 landings with their exact tested trees.
The ledger remains pre-final evidence, not acceptance of an unseen final tree.

On 2026-11-20, the final #428 assignment combined #396's two owned commits with that exact qualified parent.
It reconciled the residual assignment-kind, next-row, supervision, and implemented-versus-staged domain clauses.
This supersedes the earlier docs-only scope statement above, not the preserved behavior of the other amended ADRs.
Its required checks cover package ceilings, real command help, six briefs, both synthetic hosts, and complete/missing artifact inspection.
The final independent reviewers and the chief's combined verifier still require immutable head/tree and qualification evidence.
Only the chief retains the parent-completion claim.

Active #422/#423, #414/#415, release #398, runtime activation, installation, publication, and tags remain outside acceptance.
Inherited inactive storage and lease protections remain preserved.
No final delivery, issue closure, or runtime activation follows merely from updating this wiki.
