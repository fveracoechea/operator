---
"@fveracoechea/operator": minor
---

`operator attempt dispatch` now writes a planning records section into the brief.
It holds the planning record of each accepted planning assignment that the assignment directly depends on, and dispatch copies the artifacts of those records into `.operator/local/planning/` in the worktree, each checked against its content identity.
Planning work that an earlier release accepted has no record, and the brief says that it has no recorded decision.
A recovery and a replacement attempt carry the planning records that the launch plan recorded, so they restore the same words, also after a later acceptance.
The spec copy that a result review reads holds the same planning records as the producer brief, and the reviewer receives the same artifact copies.
The crew state moves to version 8, so run `operator update` to migrate it.
