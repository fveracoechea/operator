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

## Architecture references at the documentation base

On 2026-11-20, `fveracoechea/operator@3f40479` contained the following decision records.
These commit-pinned documents, rather than this wiki, supplied the architecture detail:

- [ADR-0029](https://github.com/fveracoechea/operator/blob/3f40479dd188a53ef43d945bc04afa5cdd88eb30/docs/adr/0029-worker-kinds-sit-on-one-assignment-model.md) recorded one assignment model, kind snapshots, the shared phase machine, and the two-return report limit.
- [ADR-0010](https://github.com/fveracoechea/operator/blob/3f40479dd188a53ef43d945bc04afa5cdd88eb30/docs/adr/0010-pr-assignments-own-their-feedback-loop-and-merge.md) recorded PR ownership and the pre-#422 one-open-parent restriction.
- [ADR-0020](https://github.com/fveracoechea/operator/blob/3f40479dd188a53ef43d945bc04afa5cdd88eb30/docs/adr/0020-a-fresh-reviewer-takes-over-a-draft-pr-before-it-is-ready.md) recorded fresh review and review gates, with later #373 changes specified separately.
- [ADR-0031](https://github.com/fveracoechea/operator/blob/3f40479dd188a53ef43d945bc04afa5cdd88eb30/docs/adr/0031-every-cli-result-names-its-next-step.md) recorded explicit next steps on results and refusals.

On 2026-11-20, this documentation task changed neither these ADRs nor `CONTEXT.md`.
The wiki recorded the spec/implementation distinction rather than silently reconciling their remaining differences.
