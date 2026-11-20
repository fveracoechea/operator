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
2. Run `operator pr associate --json`, then stop after its kind handoff.
   A ready PR with internal review off starts fresh pr-feedback.
3. As the pr-feedback launch, run `operator pr wait --json`.
   Set your shell command timeout above the default 540 seconds, or above the explicit `--timeout <seconds>`.
   Pass `--note <path|->` for open points that the next launch needs.
   The CLI retains this note only when the wait parks, with at most 60 lines.
4. Handle the result, then wait again.

- `pr_events_observed` with `feedback`: follow the claim-check and reply rules in [kinds/pr-feedback.md](kinds/pr-feedback.md).
  Items with `fromViewer: true` came from your own GitHub account, which can be your own reply or the person's comment.
  They come only together with another event.
- `pr_events_observed` with `checks_failed`: read the failing check, fix the cause, and push.
- `pr_events_observed` with `merge_eligible`: all seven merge conditions held at that head. Run `operator pr merge --json`, unless your SuperAgent told you not to merge.
- `pr_parked`: stop. Operator ends your launch and keeps the worktree for a later change.
- `pr_checks_running`: wait again for checks on your pushed head. The CLI retained no park note.
- `pr_events_observed` with `parent_relayed`: your parent PR merged. The CLI rebased your branch onto the default branch, pushed it, and changed the PR base. Pull nothing. Your worktree is at the new head. Wait again.

A PR closed without merging needs your SuperAgent's decision.
A PR merged elsewhere still needs verification through the guarded merge.
A merge while parked instead receives automatic verification and cleanup through the coordination wait.
Your replacement brief lists its durable waking events and any note from the parking wait.

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
3. Stop once it succeeds.
   Operator closes your pane and starts a fresh reviewer in your worktree, which owns the PR until ready.
   Your SuperAgent sees the handoff in `operator next`, so send it no message.

## Merge

`operator pr merge --json` reads the PR from GitHub again.
It requires an approving review decision, at least one check and every check passing, and no unresolved review thread.
It also requires the default branch as base, a non-draft PR, a finished stack relay, recorded `pr_ready`, and your worktree at the PR head.
A wait result or a supervisor's message does not replace these checks.

- `pr_merged`: GitHub reports the merge. Cleanup started in its own process. It deletes the remote branch, closes your pane, and removes your worktree, so your session ends. Send no message about the merge. Your SuperAgent's coordination wait shows the ended assignment or the cleanup it still owes.

If your wait command is killed, run it again. Your SuperAgent sees a stopped wait until you do.

Each result is reported once, also after a restart.
When you replace an earlier owner, read the PR's reviews, comments, unresolved threads, and checks before your first wait.
Keep unlanded work in the worktree. Never delete a branch or a worktree to recover.
