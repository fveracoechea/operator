---
"@fveracoechea/operator": patch
---

The `worker-agent` skill has a new `internal-review` topic for the internal reviewer of a draft PR: its inputs, the Spec, Standards, and Skills axes, at most two rounds, one summary comment, and `gh pr ready`.
Its pull-requests topic tells an implementer with internal review on to commit and push everything, open a draft PR, associate it, and stop.
The `super-agent` pull-requests topic covers the manual handoff from the implementer to the reviewer, the skip, and two rules while a PR is a draft: keep `review.assignments` off, and approve or merge no draft.
