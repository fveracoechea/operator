# PR feedback loop

Run PR commands only inside the worktree that your brief names, on its recorded branch.
The worktree selects your assignment, so the commands take no assignment or PR selector.
A refusal changes nothing. Read its reason and tell your SuperAgent when you cannot fix it.

1. Commit and push your branch, then open one PR from it with your own tools.
   Put the closing keywords for the tracker issue in the PR body.
2. Run `operator pr associate --json`.
   `pr_not_found` or `pr_ambiguous` means that exactly one open PR from your branch is needed.
3. Run `operator pr wait --json`.
   Set your shell command timeout above the wait timeout, which is 300 seconds by default and `--timeout <seconds>` otherwise.
4. Handle the result, then wait again.

- `pr_events_observed` with `feedback`: check each claim, fix valid defects, reply on the thread, and push to the same PR. Items with `fromViewer: true` came from your own GitHub account, which can be your own reply or the person's comment. They come only together with another event.
- `pr_events_observed` with `checks_failed`: read the failing check, fix the cause, and push.
- `pr_events_observed` with `merge_eligible`: all four merge conditions held at that head. Tell your SuperAgent. The guarded merge command is not in this release.
- `pr_wait_timed_out`: nothing new arrived. Wait again unless your SuperAgent told you to stop. Your SuperAgent sees the timeout until your next wait starts.
- `pr_not_open`: the PR was merged or closed outside the CLI. Stop and tell your SuperAgent. This is not a completed assignment, and you cannot associate another PR.

If your wait command is killed, run it again. Your SuperAgent sees a stopped wait until you do.

Each result is reported once, also after a restart.
When you replace an earlier owner, read the PR's reviews, comments, unresolved threads, and checks before your first wait.
Keep unlanded work in the worktree. Never delete a branch or a worktree to recover.
