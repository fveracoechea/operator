# Landing history for #373

Recorded on 2026-11-20.
Related pages: [scope](issue-373-scope.md), [user constraints](issue-373-user-constraints.md), [index](index.md).

## Delivery snapshots

On 2026-11-20, the starting checkout was `fveracoechea/operator@d0fba12ebdffd4e94d7e2b28ede0f831d31dd476`.
At that commit's timestamp, GitHub closure and PR merge timestamps accounted for ten of #373's 23 child issues.
The closed children were #374 through #382 and #385.
Their merged PRs were [#400](https://github.com/fveracoechea/operator/pull/400), [#401](https://github.com/fveracoechea/operator/pull/401), [#403](https://github.com/fveracoechea/operator/pull/403), [#399](https://github.com/fveracoechea/operator/pull/399), [#407](https://github.com/fveracoechea/operator/pull/407), [#412](https://github.com/fveracoechea/operator/pull/412), [#408](https://github.com/fveracoechea/operator/pull/408), [#404](https://github.com/fveracoechea/operator/pull/404), [#402](https://github.com/fveracoechea/operator/pull/402), and [#405](https://github.com/fveracoechea/operator/pull/405), respectively.
This delivery snapshot was superseded by the fetched-base snapshot below, not evidence of full spec completion.

On 2026-11-20, the fetched documentation base was `fveracoechea/operator@3f40479dd188a53ef43d945bc04afa5cdd88eb30`.
The [#373 child list](https://github.com/fveracoechea/operator/issues/373) then contained 13 closed children and ten open children.
The three additional landings were:

| Child                                                       | PR                                                        | Merge timestamp (UTC) | Merge commit                                                     |
| ----------------------------------------------------------- | --------------------------------------------------------- | --------------------- | ---------------------------------------------------------------- |
| [#383](https://github.com/fveracoechea/operator/issues/383) | [#406](https://github.com/fveracoechea/operator/pull/406) | 2026-11-20 03:33:32   | `fveracoechea/operator@3ff79df19f51f79a71588a4c3ef7ff1432bea304` |
| [#384](https://github.com/fveracoechea/operator/issues/384) | [#424](https://github.com/fveracoechea/operator/pull/424) | 2026-11-20 03:49:54   | `fveracoechea/operator@994342cd059700dbe13c57e726a549ff6b00cbd6` |
| [#386](https://github.com/fveracoechea/operator/issues/386) | [#418](https://github.com/fveracoechea/operator/pull/418) | 2026-11-20 04:05:59   | `fveracoechea/operator@3f40479dd188a53ef43d945bc04afa5cdd88eb30` |

On 2026-11-20, GitHub reported #406's final head as `fveracoechea/operator@b21af24ddcc9a5a33886e43f7d27120f84b8e3d9`.
The local report `/tmp/opencode/issue373-pr406-evidence.md` independently recorded that the merge preceded its preparation assignment.
That report was a local context pointer, not a permanent public URL or fresh compliance review.
On 2026-11-20, the [#427 merge](https://github.com/fveracoechea/operator/pull/427) delivered the two-return report cap at `fveracoechea/operator@05b5d387ed062013fd98452616d1ffce6a5c9823`.
The [#426 merge](https://github.com/fveracoechea/operator/pull/426) instead delivered worker-context presentation at `fveracoechea/operator@6cd08f75ef9f1ec153e15548509652d0d1b6f12b`.
This corrected the earlier cap attribution relayed to the supervising session; #426 was not the cap PR.

On 2026-11-20, [#419](https://github.com/fveracoechea/operator/pull/419) for #387 remained draft at `fveracoechea/operator@1ec26d9c4cbd93a0240b58941137796ab0c41951`, based on main.
On that date, [#420](https://github.com/fveracoechea/operator/pull/420) for #388 remained draft at `fveracoechea/operator@b14ddab5b1183be30a5ec89e529f3228bfe1f151`, based on `spec-373/issue-388-dependencies`.
The fetched-main landings did not establish that either draft passed final-head integration checks.
Supersession observed later on 2026-11-20: #419 became non-draft at the same head and main base, but remained open and unmerged.
That observation replaced its earlier draft status, not the need to verify qualification before landing.
On that date, #389 through #396 also remained open.
The #373 parent remained open; these counts alone did not satisfy its acceptance criteria.

## Merge hold and #422

On 2026-11-17, [#422](https://github.com/fveracoechea/operator/issues/422) recorded approval for owner-safe open-parent refresh and per-child dependency-only integration bases.
It also recorded a whole-stack merge hold, including that prerequisite itself.
It required fresh review after integration changed the head or base, while preserving ownership, recoverable work, and ordinary merge guards.
Its implementation PR was [#423](https://github.com/fveracoechea/operator/pull/423), observed draft on 2026-11-20.

Supersession recorded on 2026-11-20: the [#420 comment dated 2026-11-18](https://github.com/fveracoechea/operator/pull/420#issuecomment-6966352937) explicitly released the earlier batch merge hold.
That comment retained readiness gates and said it did not authorize a merge, release, or runtime activation.
It did not establish that #422's requested tooling had landed or that its technical safety requirements could be skipped.
The older hold remained visible in #422 and #420's body; those sources were not rewritten by this wiki.
The [2026-11-20 user delegation](issue-373-user-constraints.md#delegated-user-decisions-on-2026-11-20) separately allowed main merges to complete #373.
That delegation still did not authorize this documentation agent to merge or mark a PR ready.

## Native Git and GitHub safeguards recorded on 2026-11-20

On 2026-11-20, the documentation delegation required native Git/`gh` rather than Operator or Herdr for this effort.
The following landing checklist preserved the ownership and verification requirements recorded in #422 and the [user constraints](issue-373-user-constraints.md):

1. Work in a new isolated branch/worktree from a fetched, recorded main commit.
2. Inspect status and ownership before changing a candidate; retain unfamiliar work and recoverable refs.
3. Pin the candidate head, base, and prerequisite heads before integration or review.
4. After a head or base change, rerun applicable checks and obtain fresh review of the actual diff.
5. Verify approval, exact-head CI, unresolved threads, non-draft status, main base, and landed prerequisites before any authorized merge.
   The separate GitHub approval and CI requirements were superseded by the later 2026-11-20 decision below.
6. After an uncertain GitHub write, read the result before considering another write; never infer success or repeat blindly.

On 2026-11-20, these safeguards did not authorize branch rewriting, prerequisite-owner changes, work deletion, runtime installation, or publication.
The documentation assignment ended at a committed draft PR, with no merge or ready transition.

Later on 2026-11-20, the person's [local qualification decision](issue-373-user-constraints.md#local-qualification-decision-on-2026-11-20) replaced checklist item 5's approval and CI requirements for this effort.
Independent native-agent review and passing local tests and full quality checks qualified a candidate without separate GitHub approval or completed CI.
No failed local gate could be bypassed.
The other safeguards and the documentation agent's draft-only boundary remained unchanged.

## Baseline evidence limit recorded on 2026-11-20

On 2026-11-20, the delegation named `/tmp/opencode/issue373-baseline-main-d0fba12-20261119` as a baseline artifact location.
The documentation agent found a checkout there, but did not verify a report supporting static-check or 128-test success.
This wiki therefore made no baseline-pass claim.
That local path was not a permanent evidence URL and did not prove later integration or live-runtime behavior.
