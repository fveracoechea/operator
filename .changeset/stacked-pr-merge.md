---
"@fveracoechea/operator": patch
---

`operator pr merge` now merges a PR that GitHub keeps in a stack. GitHub refused these with `http_403: Merging stacked PRs via this endpoint is not supported`.
The guarded merge now sends every PR to GitHub's asynchronous merge endpoint as a direct merge, still pinned to the guarded head.
It reads the merge request until it ends, and it reports `pr_merged` only after GitHub shows the PR merged at that head.
