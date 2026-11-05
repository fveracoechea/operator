---
"@fveracoechea/operator": patch
---

`operator pr merge` now refuses a draft PR with `pr_merge_blocked`, and `operator pr wait` no longer reports `merge_eligible` for a draft. It still reports a draft's feedback and failing checks.
Both commands read the draft state from GitHub and report it as `notDraft` in `mergeConditions`. A PR that leaves draft at an eligible head reports `merge_eligible` on the next wait.
The `worker-agent` and `super-agent` skills drop their prose rule against merging a draft, because the merge gate now owns it.
