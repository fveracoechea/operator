# Coordination history

On 2026-11-20, the person approved `docs/wiki/` as the shared chief-of-staff wiki for #373.
The [constraints page](issue-373-user-constraints.md) records the source and authority limits of that decision.

## Scope and decisions

- [Next release scope for #414 and #422](operator-next-release-414-422.md): The 2026-11-21 completion and landing authority, selected policies, integration order, and separate release gates.

- [Worker-kind spec history](issue-373-scope.md): Dated scope, amendment reversals, and architecture sources for #373.
- [Landing history](issue-373-landing.md): Commit-pinned delivery snapshots, the released batch hold, and landing safeguards with the local-qualification exception.
- [Recovery findings](issue-373-recovery.md): Dated red evidence and its superseding qualified landings, with unfinished mutation diagnostics retained.

## User constraints and coordination lessons

- [User constraints](issue-373-user-constraints.md): The 2026-11-20 delegation, local-qualification and later ownership decisions, excluded device/release work, and chief-of-staff procedure pointers.
- [Native delegation retro](issue-373-native-delegation-retro.md): The 2026-11-20 routing lesson, ten-case batch retro, external qualification runner, and deferred environment changes.

## Earlier checkpoint on 2026-11-20

The [#429 merge supersession](issue-373-recovery.md#qualified-429-merge) records 3,992 passing tests, static quality, both clean independent reviews, and tested-tree equality.
The [#420 supersession](issue-373-recovery.md#assembled-420-and-test-only-qualification-corrections) records the corrected draft without transferring earlier narrow mutation passes to whole-candidate qualification.
The [published downstream checkpoint](issue-373-recovery.md#published-downstream-drafts-and-eight-inherited-failures) records drafts #430/#431/#432 and eight inherited fixture failures with an active fix owner.
The [acceptance scope](issue-373-scope.md#final-acceptance-scope-checkpoint-on-2026-11-20) covers all 23 children and separates inactive stack storage from active #422/#423 work.
The [chief-of-staff acceptance ownership](issue-373-user-constraints.md#combined-acceptance-ownership-on-2026-11-20) remains an open responsibility, not a completion claim.

## Later gates checkpoint on 2026-11-20

- The [guard decision](issue-373-user-constraints.md#automatic-guards-left-unchanged-on-2026-11-20) retained automatic OpenCode guards and ordinary Git after the 65-worktree audit.
- The [batch retro and external runner](issue-373-native-delegation-retro.md#batch-retro-and-external-qualification-runner) record 20 synthetic passes and six killed guard breaks, not application qualification.
- The [whole #420 campaign](issue-373-recovery.md#blocked-420-whole-candidate-qualification) remained blocked by 27 diagnostic survivors and one timeout; local test corrections did not advance its published head.
- The [corrected published #430](issue-373-recovery.md#reviewed-and-corrected-430-readiness) fixed readiness authorization and reviewer-note quoting, with 815 scoped passes but no merge qualification.
- The [fixture and child checkpoint](issue-373-recovery.md#fixture-corrections-and-additional-published-drafts) records all eight fixture corrections and draft #433/#434, without claiming every child refreshed.
- [Main remained at the qualified #429 merge](issue-373-landing.md#later-landing-checkpoint-on-2026-11-20); the [23-child acceptance scope](issue-373-scope.md#final-acceptance-scope-checkpoint-on-2026-11-20) still required combined proof.

## Reading and updates

The [verified landing chain](issue-373-landing.md#qualified-main-chain-on-2026-11-20) supersedes the older draft and main pointers above.
The [final package checkpoint](issue-373-scope.md#final-role-package-checkpoint-on-2026-11-20) names the remaining #396 and combined-acceptance limits.
That checkpoint also records the independent 22-runtime-delivery verification at actual #436 main, without claiming final package acceptance.
The [current qualification decision](issue-373-user-constraints.md#final-package-authority-on-2026-11-20) makes mutation diagnostics non-gating without calling unfinished results clean.

On 2026-11-20, this wiki adopted the historical-record rules in the [chief-of-staff skill at `fveracoechea/operator@3f40479`](https://github.com/fveracoechea/operator/blob/3f40479dd188a53ef43d945bc04afa5cdd88eb30/.agents/skills/chief-of-staff/SKILL.md).
Every factual entry needs an observation or decision date; a code claim also needs its repository and commit.
Before a coordination decision, read the relevant pages and verify changed facts against their sources.
When a later decision changes an entry, retain the earlier entry, mark it superseded, and link the replacement.
Update every affected page and this index.
Keep source issues, PRs, ADRs, and reports outside the wiki; cite them rather than duplicate or edit them.

## Next-release composition checkpoint on 2026-11-21

The [verified #415 landing](operator-next-release-414-422.md#verified-415-landing-on-2026-11-21) records actual main `c274f62`, clean final reviews, qualification, CI, and tested-tree equality.
The [#423 correction record](operator-next-release-414-422.md#reviewed-423-corrections-and-notes-on-2026-11-21) records four resolved findings, clean `93cc539` reviews, and the approved 16-note import.
The [actual-parent composition](operator-next-release-414-422.md#actual-parent-423-composition-and-remaining-gates-on-2026-11-21) retains final #423 review, qualification, smoke, CI, and live merge gates.
Feature landing still does not authorize publication or runtime activation.
