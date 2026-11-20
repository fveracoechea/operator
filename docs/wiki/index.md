# Coordination history

On 2026-11-20, the person approved `docs/wiki/` as the shared chief-of-staff wiki for #373.
The [constraints page](issue-373-user-constraints.md) records the source and authority limits of that decision.

## Scope and decisions

- [Worker-kind spec history](issue-373-scope.md): Dated scope, amendment reversals, and architecture sources for #373.
- [Landing history](issue-373-landing.md): Commit-pinned delivery snapshots, the released batch hold, and landing safeguards with the local-qualification exception.
- [Recovery findings](issue-373-recovery.md): The 2026-11-20 recovery history, qualified #429 merge, corrected draft #420, and published downstream drafts with unresolved qualification gates.

## User constraints and coordination lessons

- [User constraints](issue-373-user-constraints.md): The 2026-11-20 delegation, local-qualification and later ownership decisions, excluded device/release work, and chief-of-staff procedure pointers.
- [Native delegation retro](issue-373-native-delegation-retro.md): The 2026-11-20 PR #420 routing failure, verified sources, bounded process correction, and deferred environment changes.

## Latest checkpoint on 2026-11-20

The [#429 merge supersession](issue-373-recovery.md#qualified-429-merge) records 3,992 passing tests, static quality, both clean independent reviews, and tested-tree equality.
The [#420 supersession](issue-373-recovery.md#assembled-420-and-test-only-qualification-corrections) records the corrected draft without transferring earlier narrow mutation passes to whole-candidate qualification.
The [published downstream checkpoint](issue-373-recovery.md#published-downstream-drafts-and-eight-inherited-failures) records drafts #430/#431/#432 and eight inherited fixture failures with an active fix owner.
The [acceptance scope](issue-373-scope.md#final-acceptance-scope-checkpoint-on-2026-11-20) covers all 23 children and separates inactive stack storage from active #422/#423 work.
The [chief-of-staff acceptance ownership](issue-373-user-constraints.md#combined-acceptance-ownership-on-2026-11-20) remains an open responsibility, not a completion claim.

## Reading and updates

On 2026-11-20, this wiki adopted the historical-record rules in the [chief-of-staff skill at `fveracoechea/operator@3f40479`](https://github.com/fveracoechea/operator/blob/3f40479dd188a53ef43d945bc04afa5cdd88eb30/.agents/skills/chief-of-staff/SKILL.md).
Every factual entry needs an observation or decision date; a code claim also needs its repository and commit.
Before a coordination decision, read the relevant pages and verify changed facts against their sources.
When a later decision changes an entry, retain the earlier entry, mark it superseded, and link the replacement.
Update every affected page and this index.
Keep source issues, PRs, ADRs, and reports outside the wiki; cite them rather than duplicate or edit them.
