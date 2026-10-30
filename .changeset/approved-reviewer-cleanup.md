---
"@fveracoechea/operator": patch
---

An approved review request now releases its reviewer. `operator review post` closes the reviewer pane and removes its worktree and local branch, and its result has a `cleanup` field.
The request record stays, so a renewed review request after approval starts a round that `operator review next` gives to a replacement reviewer with the earlier drafts.
`operator review cleanup` now accepts an approved request, so it also releases reviewers that an earlier release kept after approval.
Unlanded reviewer work stays, and a failed cleanup stays visible, as for a closed or skipped request.
