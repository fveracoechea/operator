---
"@fveracoechea/operator": minor
---

The internal reviewer ends its review with `operator pr ready --file <summary.json> --json`.
It refuses until every recorded finding has one disposition, each declined finding has a reason, a round 1 blocker that was applied has a round 2, and the worktree is clean at the PR head.
It then posts one summary comment, which the CLI renders with a line for each finding, marks the PR ready, and records the ready head. A retry after a lost answer finds the earlier comment and posts no second one.
On the person's instruction, the SuperAgent skips a running review with `operator internal-review skip --source <id> --assignment <key> --person-instructed --json`, which marks the PR ready with no comment.
`operator pr merge` refuses, and `operator pr wait` reports no `merge_eligible`, until the internal review ended ready or skipped. `mergeConditions` gains `reviewEnded`.
With `review.assignments` on, the assignment reviewer is queued when the internal review ends instead of at the association.
A launch after the review ended gets the PR owner brief, which says how the review ended. A new state migration adds the end of the review.
