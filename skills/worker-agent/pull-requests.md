# PR feedback loop

Run PR commands only inside the worktree that your brief names, on its recorded branch.
The worktree selects your assignment, so the commands take no assignment or PR selector.
A refusal changes nothing. Read its reason and tell your SuperAgent when you cannot fix it.

Your brief says when internal review is on for your assignment.
Then, as the implementer, follow "Internal review" below instead of these steps.
As the internal reviewer, read [internal-review.md](internal-review.md).

1. Commit and push your branch with `git push -u`, then open one PR from it with your own tools.
   Put the closing keywords for the tracker issue in the PR body.
   Use the PR base that your brief names: the default branch, or the branch of the parent PR that your branch starts on.
2. Run `operator pr associate --json`.
   `pr_not_found` or `pr_ambiguous` means that exactly one open PR from your branch is needed.
   `pr_base_invalid` means that the PR base is not the default branch or a dependency's PR branch, or that it is the default branch while a dependency's PR is open. Change the base, then repeat.
3. Run `operator pr wait --json`.
   Set your shell command timeout above the wait timeout, which is 300 seconds by default and `--timeout <seconds>` otherwise.
4. Handle the result, then wait again.

- `pr_events_observed` with `feedback`: check each claim, fix valid defects, reply on the thread, and push to the same PR. Items with `fromViewer: true` came from your own GitHub account, which can be your own reply or the person's comment. They come only together with another event.
- `pr_events_observed` with `checks_failed`: read the failing check, fix the cause, and push.
- `pr_events_observed` with `merge_eligible`: all five merge conditions held at that head. Run `operator pr merge --json`, unless your SuperAgent told you not to merge.
- `pr_wait_timed_out`: nothing new arrived. Wait again unless your SuperAgent told you to stop. Your SuperAgent sees the timeout until your next wait starts.
- `pr_events_observed` with `parent_relayed`: your parent PR merged. The CLI rebased your branch onto the default branch, pushed it, and changed the PR base. Pull nothing. Your worktree is at the new head. Wait again.
- A `relay_*` refusal: the relay stopped and kept your branch. `relay_conflict` means that you rebase onto the default branch yourself, push, and wait again. `relay_worktree_unclean` and `relay_worktree_unsynced` mean that you commit and push first. `relay_worktree_branch` and `relay_rebase_in_progress` mean that you finish or abort your rebase and switch back to your branch first. `relay_parent_closed` and `relay_parent_base` need your SuperAgent. A failed fetch, push, or base change can be retried with the next wait.
- `pr_not_open`: the PR was merged or closed outside the CLI. If it was merged, run `operator pr merge --json`. It verifies the merge and starts cleanup. If it was closed, stop and tell your SuperAgent. You cannot associate another PR.

## Internal review

1. Commit and push all your work. `git status --short` prints nothing, and `git status -sb` shows no commits ahead of the remote.
   The reviewer reads only what the PR holds.
2. Open the PR as a draft from your branch with your own tools, for example `gh pr create --draft`.
   Use the closing keywords and the PR base that your brief names.
3. Run `operator pr associate --json`, and handle its refusals as in step 2 above.
4. Tell your supervising SuperAgent that the draft PR is ready for internal review, then stop.
   A fresh reviewer takes over your worktree and owns the PR until its merge, so you run no `operator pr wait` and leave the PR a draft.

## Merge

Merge only a ready PR. A draft PR is under internal review, also when a wait returns `merge_eligible` for it.
`operator pr merge --json` reads the PR from GitHub again. It merges only with an approving review decision, at least one check and every check passing, no unresolved review thread, the default branch as base, a finished relay for a stacked PR, and your worktree at the PR head.
A wait result or a supervisor's message does not replace these checks.

- `pr_merged`: GitHub reports the merge. Cleanup started in its own process. It deletes the remote branch, closes your pane, and removes your worktree, so your session ends. Tell your SuperAgent that you start the merge before you run the command, because your session ends after `pr_merged`.
- `pr_merge_blocked`: a condition failed. Its detail names it. Wait again.
- `pr_head_mismatch`: push your commits, or tell your SuperAgent, then wait again.
- `pr_merge_refused`, `pr_merge_unverified`, `github_uncertain`: nothing was recorded. Run the command again once. Tell your SuperAgent when it fails again.

If your wait command is killed, run it again. Your SuperAgent sees a stopped wait until you do.

Each result is reported once, also after a restart.
When you replace an earlier owner, read the PR's reviews, comments, unresolved threads, and checks before your first wait.
Keep unlanded work in the worktree. Never delete a branch or a worktree to recover.
