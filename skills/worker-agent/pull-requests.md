# PR feedback loop

Run PR commands only inside the worktree that your brief names, on its recorded branch.
The worktree selects your assignment, so the commands take no assignment or PR selector.
Follow each result's `next`. Route its decisions through [responsibility.md](responsibility.md).

Your brief says when internal review is on for your assignment.
Then, as the implementer, follow "Internal review" below instead of these steps.
As the internal reviewer, read [internal-review.md](internal-review.md).

1. Commit and push your branch with `git push -u`, then open one PR from it with your own tools.
   Put the closing keywords for the tracker issue in the PR body.
   Use the PR base that your brief names: the default branch, or the branch of the parent PR that your branch starts on.
2. Run `operator pr associate --json`.
3. Run `operator pr wait --json`.
   Set your shell command timeout above the wait timeout, which is 300 seconds by default and `--timeout <seconds>` otherwise.
4. Handle the result, then wait again.

- `pr_events_observed` with `feedback`: check each claim, fix valid defects, reply on the thread, and push to the same PR. Items with `fromViewer: true` came from your own GitHub account, which can be your own reply or the person's comment. They come only together with another event.
- `pr_events_observed` with `checks_failed`: read the failing check, fix the cause, and push.
- `pr_events_observed` with `merge_eligible`: all seven merge conditions held at that head. Run `operator pr merge --json`, unless your SuperAgent told you not to merge.
- `pr_wait_timed_out`: nothing new arrived. Wait again unless your SuperAgent told you to stop. Your SuperAgent sees the timeout until your next wait starts.
- `pr_events_observed` with `parent_relayed`: your parent PR merged. The CLI rebased your branch onto the default branch, pushed it, and changed the PR base. Pull nothing. Your worktree is at the new head. Wait again.

A PR closed without merging needs your SuperAgent's decision.
A PR merged elsewhere still needs verification through the guarded merge.

## Stacked PRs

Operator owns a stack of PRs. The relay rebases, pushes, and changes the base after a parent merges, and `operator pr merge` merges.
Use `gh stack view --json` only to read a stack. Run no other `gh stack` command, also when the `gh-stack` skill loads.

- `gh stack sync` and `gh stack rebase` rewrite every branch in the stack and update the clean worktrees of other WorkerAgents.
- `gh stack merge` merges every PR below its target at once, without the checks of `operator pr merge`.

## Internal review

1. Open the PR as a draft from your branch with your own tools, for example `gh pr create --draft`.
   Use the closing keywords and the PR base that your brief names.
2. Commit and push all your work, then run `operator pr associate --json`.
   The reviewer reads only the pushed PR head.
3. Stop once it succeeds. Operator closes your pane and starts a fresh reviewer in your worktree, which owns the PR until its merge.
   Your SuperAgent sees the handoff in `operator next`, so send it no message.

## Merge

`operator pr merge --json` reads the PR from GitHub again. It merges only with an approving review decision, at least one check and every check passing, no unresolved review thread, the default branch as base, the ready-for-review state, a finished relay for a stacked PR, an internal review that ended ready or skipped, and your worktree at the PR head.
A wait result or a supervisor's message does not replace these checks.

- `pr_merged`: GitHub reports the merge. Cleanup started in its own process. It deletes the remote branch, closes your pane, and removes your worktree, so your session ends. Send no message about the merge. Your SuperAgent's coordination wait shows the ended assignment or the cleanup it still owes.

If your wait command is killed, run it again. Your SuperAgent sees a stopped wait until you do.

Each result is reported once, also after a restart.
When you replace an earlier owner, read the PR's reviews, comments, unresolved threads, and checks before your first wait.
Keep unlanded work in the worktree. Never delete a branch or a worktree to recover.
