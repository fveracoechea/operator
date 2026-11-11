---
"@fveracoechea/operator": minor
---

A PR assignment can adopt an open PR that Operator did not create. Set `adopt` to the PR number and `branch` to its head branch in the plan.
Dispatch reads the PR, puts its branch at the PR head in a new worktree, and starts an owner whose brief says to read the PR and its review threads, associate it, and run the feedback loop and guarded merge.
It refuses, and names the work, when the local branch has commits that the PR lacks or a worktree has the branch checked out.
A ready adopted PR gets no internal review, and an adopted draft keeps it.
