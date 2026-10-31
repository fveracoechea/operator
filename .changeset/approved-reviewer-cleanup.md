---
"@fveracoechea/operator": patch
---

An approval now cleans up the reviewer of a review request.
`operator review post` closes the reviewer pane and removes its worktree and local branch.
Its result has a `cleanup` field.
The request record stays, so a renewed review request after approval starts a new round.
`operator review next` gives that round to a replacement reviewer, which reads the earlier drafts.
`operator review cleanup` now accepts an approved request.
It also cleans up the reviewers that earlier Operator versions kept after an approval.
Unlanded reviewer work stays with the person, and a failed cleanup stays visible, as for a closed or skipped request.
A renewed request after a cleanup that kept unlanded work gets no replacement until the person runs `operator review cleanup`.
