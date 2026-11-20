# User constraints for the #373 completion effort

Recorded on 2026-11-20.
Related pages: [scope](issue-373-scope.md), [landing history](issue-373-landing.md), [index](index.md).

## Delegated user decisions on 2026-11-20

On 2026-11-20, the supervising session relayed these verified user decisions in this documentation assignment:

- The person allowed merges to main for completing [#373](https://github.com/fveracoechea/operator/issues/373).
- The person required native subagents and Git/`gh`, and asked agents to avoid the Operator CLI.
- The person excluded inspection, migration, repair, or removal of real legacy Operator state.
- The person approved `docs/wiki/` as the new shared wiki location.

On 2026-11-20, the assignment supplied no public transcript URL for those decisions.
Their provenance was the supervising session's delegation, not an invented GitHub approval or a new human answer by this agent.
The documentation assignment itself prohibited Operator and Herdr invocation and inspection of real device state.
The later [automatic-guard decision](#automatic-guards-left-unchanged-on-2026-11-20) clarified manual-command avoidance without disabling host callbacks.
It authorized a docs-only commit and draft PR referencing #373, but not a merge, ready transition, deletion, or main-checkout modification.

On 2026-11-20, runtime installation, runtime activation, release publication, and tags remained outside this delegation.
Main-merge permission did not expand those boundaries.
At `fveracoechea/operator@3f40479`, [ADR-0007](https://github.com/fveracoechea/operator/blob/3f40479dd188a53ef43d945bc04afa5cdd88eb30/docs/adr/0007-one-running-release-serves-the-device-and-migrates-state.md) also required explicit publication authorization.
At that commit, [ADR-0009](https://github.com/fveracoechea/operator/blob/3f40479dd188a53ef43d945bc04afa5cdd88eb30/docs/adr/0009-readiness-checks-static-prerequisites-without-live-probes.md) distinguished static prerequisite checks from proof of live capability.

## Local qualification decision on 2026-11-20

On 2026-11-20, the supervising session relayed the person's answer to the merge-approval question: "Yes, no CI required if all tests and quality check pass locally".
The delegation clarified that independent native-agent review plus passing local tests and full quality checks qualified this effort.
It required neither a separate GitHub approval nor completed CI, but permitted no failed local gate to be bypassed.
This superseded the initial [landing checklist's separate GitHub approval and exact-head CI requirements](issue-373-landing.md#native-git-and-github-safeguards-recorded-on-2026-11-20) for this effort only.
It did not waive unresolved-thread, draft, base, prerequisite, or work-preservation safeguards.
It did not authorize this documentation agent to merge or mark ready.
It granted no runtime or release authority.
As with the earlier decisions, the source was the supervising session's dated delegation; no public transcript URL was supplied.

On 2026-11-20, the later wiki-ingest delegation authorized updating existing docs-only [PR #428](https://github.com/fveracoechea/operator/pull/428) through a safe fast-forward push.
It required a new isolated worktree at the verified remote head and retained the original documentation worktree untouched.
It limited this ingest to documentation format, link, index, and privacy checks during the separate qualification campaigns.
It authorized no full-quality or full-suite run, ready transition, merge, issue closure, review post, deletion, release, or runtime operation.
This extended the earlier documentation publication assignment, not the implementation candidates' authority or qualification.
The source was the supervising session's dated native delegation; no public transcript URL was supplied.
The [recovery page](issue-373-recovery.md#qualification-evidence-limits) records the associated evidence limits.

On 2026-11-20, the chief separately [kept reviewer-prompt invariants subordinate to canonical product sources](issue-373-recovery.md#conditional-bookkeeping-finding-and-disposition).
The delegation treated write-free recovery bookkeeping as nonblocking unless those sources required it, while retaining verification of potentially false refusal metadata.
This was a review disposition, not a new human answer, spec amendment, or waiver of the independent Standards findings.

## Later ownership decision on 2026-11-20

After the initial wiki commit, `fveracoechea/operator@4ee11c1`, the supervising session relayed the person's instruction to take ownership of the existing stack.
On 2026-11-20, that delegation stated that no other agent owned the stack.
This superseded the unresolved ownership assumption in the earlier local inventory, `/tmp/opencode/issue373-local-work-map.md`, for this completion effort.
That inventory remained a dated source, not an ownership block after the handoff.
The source of the later decision was this review assignment's supervising-session delegation; no public transcript URL was supplied.
The decision retained work-preservation requirements and the [landing safeguards](issue-373-landing.md#native-git-and-github-safeguards-recorded-on-2026-11-20).
It did not waive independent review or any local test or quality gate.
It granted this documentation reviewer no ready, merge, runtime, release, or real-state authority.

## Combined acceptance ownership on 2026-11-20

On 2026-11-20, the supervising chief-of-staff retained direct responsibility for the combined acceptance ledger and cross-ticket qualification.
After the stack reached a stable integrated candidate, that chief-of-staff would dispatch a fresh verifier against the final immutable head/base.
This named an owner and a future verification step; it did not claim that verification ran or acceptance completed.
The source was the supervising session's dated native checkpoint delegation, alongside `/tmp/opencode/issue373-final-acceptance-map.md`.
This resolved the planner's open ownership recommendation without rewriting that local planning source.

On 2026-11-20, the same delegation recorded an active parent-fixture fix owner for the [eight inherited failures](issue-373-recovery.md#published-downstream-drafts-and-eight-inherited-failures).
Inherited provenance did not waive those failures or any final local gate.
The [acceptance scope checkpoint](issue-373-scope.md#final-acceptance-scope-checkpoint-on-2026-11-20) found no missing feature ticket; the pending work was integration and combined proof.
The documentation agent's authority remained a safe fast-forward update to draft #428, with format, link, index, and privacy checks only.
Original work, real-state exclusions, and the runtime/release boundary remained unchanged.

## Automatic guards left unchanged on 2026-11-20

On 2026-11-20, the hook audit found no active Git hooks across all 65 then-registered worktrees.
Temporary `core.hooksPath` overrides were unnecessary; the audit found no prohibited co-author tokens in its stated history scans.
It separately found an installed OpenCode plugin that calls Operator automatically for matching shell commits and session idle.
At `fveracoechea/operator@f19411de627451032dd5796e77af3e83d606ec2b`, [ADR-0021](https://github.com/fveracoechea/operator/blob/f19411de627451032dd5796e77af3e83d606ec2b/docs/adr/0021-a-claude-code-hook-keeps-co-authored-by-trailers-out-of-commits.md#opencode) documented this separate host guard.
The primary audit source was `/tmp/opencode/issue373-native-hook-audit.md`.

Later on 2026-11-20, the supervising delegation relayed the person's choice, "Leave guards unchanged".
The task constraint therefore meant avoiding manual Operator CLI and Herdr commands, while retaining automatic OpenCode guards and ordinary Git checks.
This clarified the earlier blanket CLI wording and resolved the audit's host-policy question without authorizing configuration changes or hook bypasses.
The source was the dated supervising delegation; no public transcript URL was supplied.
Historical automatic Operator execution remained unverified, not established absent.
Neither the audit nor this clarification proved that automatic host callbacks left device state untouched.
The real legacy/device-state exclusions still governed the agents' own work.

## Final package authority on 2026-11-20

On 2026-11-20, the supervising delegation assigned final #396 integration and wiki/domain reconciliation to existing [PR #428](https://github.com/fveracoechea/operator/pull/428).
The person wanted existing PRs landed, not new drafts.
This superseded this owner's earlier docs-only and draft-only boundary.
The assignment required a fresh isolated worktree, ordinary history-preserving integration, an ordinary fast-forward push, and frozen full local quality.
It preserved the existing PR body unless a user-visible draft preceded any replacement.

Conditional landing required actual #436 merge/tree verification, passing final #428 full quality, and relayed clean independent Standards and Spec/Design reviews.
Fresh live refs, threads, change requests, and prospective tested-tree equality remained required.
Once those gates passed, the owner could mark ready and merge immediately with the exact head, without another coordinator wait.
CI, a separate GitHub approval, and mutation diagnostics were not additional gates.
Actual correctness or acceptance defects remained blockers.
This was task-specific authority, not a change to Operator's product merge gate.

The delegation retained all original and dependency-used worktrees, external evidence, automatic guards, and legacy/device-state exclusions.
It authorized no comments, review posts, manual issue closure, force pushes, new PRs, runtime operations, release, or publication.
Only this owner's clean unused task worktree could be removed after verified merge.
The chief retained final combined acceptance and parent completion.
The source was the dated supervising delegation, not an invented public approval or transcript.

## Known chief-of-staff pointer limitation

On 2026-11-20, at `fveracoechea/operator@3f40479`, the [chief-of-staff skill](https://github.com/fveracoechea/operator/blob/3f40479dd188a53ef43d945bc04afa5cdd88eb30/.agents/skills/chief-of-staff/SKILL.md) named four sibling procedure paths.
The repository tree at that commit contained none of their targets: `../retro/SKILL.md`, `../to-spec/SKILL.md`, `../to-tickets/SKILL.md`, or `../implement-spec/SKILL.md`.
This was a checkout-local pointer limitation, not proof that the skills were absent from every host installation.
On 2026-11-20, the documentation assignment excluded repairing those pointers or editing globally installed skills.
This entry retained the limitation for a later authorized task rather than treating missing procedures as executed.

Later on 2026-11-20, the [native delegation retro](issue-373-native-delegation-retro.md#procedure-access-and-existing-checks) verified the four procedures under `/home/fveracoechea/.agents/skills/`.
This supplemented the checkout-local limitation without repairing the relative links.
The retro used the installed retro procedure; locating the other three procedures did not establish their execution.
