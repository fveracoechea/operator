# PR feedback loop

Run PR commands only inside the worktree that your brief names, on its recorded branch.
The worktree selects your assignment, so the commands take no assignment or PR selector.
A refusal changes nothing. Read its reason. When you cannot fix it, record a question with the refusal as its content, as [responsibility.md](responsibility.md) says.

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
- `pr_events_observed` with `merge_eligible`: the merge conditions held at that head. Run `operator pr merge --json`, unless your SuperAgent told you not to merge.
- `pr_wait_timed_out`: nothing new arrived. Wait again unless your SuperAgent told you to stop. Your SuperAgent sees the timeout until your next wait starts.
- `pr_events_observed` with `parent_relayed`: your parent PR merged. The CLI rebased your branch onto the default branch, pushed it, and changed the PR base. Pull nothing. Your worktree is at the new head. Wait again.
- A `relay_*` refusal: the relay stopped and kept your branch. `relay_conflict` means that you rebase onto the default branch yourself with Git, push, and wait again. `relay_worktree_unclean` and `relay_worktree_unsynced` mean that you commit and push first. `relay_worktree_branch` and `relay_rebase_in_progress` mean that you finish or abort your rebase and switch back to your branch first. `relay_parent_closed` and `relay_parent_base` need your SuperAgent, so record a question with the refusal. A failed fetch, push, or base change can be retried with the next wait.
- `pr_not_open`: the PR was merged or closed outside the CLI. If it was merged, run `operator pr merge --json`. It verifies the merge and starts cleanup. If it was closed, record a question with the refusal, then stop. You cannot associate another PR.

## Stacked PRs

Operator owns a stack of PRs. The relay rebases, pushes, and changes the base after a parent merges, and `operator pr merge` merges.
Use `gh stack view --json` only to read a stack. Run no other `gh stack` command, also when the `gh-stack` skill loads.

- `gh stack sync` and `gh stack rebase` rewrite every branch in the stack and update the clean worktrees of other WorkerAgents.
- `gh stack merge` merges every PR below its target at once, without the checks of `operator pr merge`.

## Internal review

1. Open the PR as a draft from your branch with your own tools, for example `gh pr create --draft`.
   Use the closing keywords and the PR base that your brief names.
2. Commit and push all your work, then run `operator pr associate --json`.
   The reviewer reads only what the PR holds, so associate refuses `pr_draft_required` for a PR that is not a draft, `pr_worktree_unclean` for changed or untracked files, and `pr_worktree_unsynced` for a worktree head that is not the PR head.
   Fix the cause and run it again. Handle its other refusals as in step 2 above.
3. Stop once it succeeds. Operator closes your pane and starts a fresh reviewer in your worktree, which owns the PR until its merge.
   Your SuperAgent sees the handoff in `operator next`, so send it no message.
   Any later PR command from your launch refuses with `pr_handed_off`.

## Merge

`operator pr merge --json` reads the PR from GitHub again.
It requires genuine GitHub approval, at least one check with every current check passing, and no unresolved review thread.
The PR must target the default branch, be ready for review, and have a finished relay when stacked.
Internal review must have ended ready or skipped, and your clean pushed worktree head must equal the PR head.
After review, a changed head needs the bounded correction validation below.
A wait result or a supervisor's message does not replace these checks.
Chat never supplies GitHub approval. Use only this guarded merge path, never a direct `gh` merge.
Source-wide merge holds also block delivery; [../super-agent/obligations.md](../super-agent/obligations.md) owns their release policy.
For delivery claims, locks, and idle-owner supervisor delivery, see [the delivery policy](../super-agent/pull-requests.md#guarded-delivery).

- `pr_merged`: GitHub reports the merge. Cleanup started in its own process. It deletes the remote branch, closes your pane, and removes your worktree, so your session ends. Send no message about the merge. Your SuperAgent's coordination wait shows the ended assignment or the cleanup it still owes.
- `pr_merge_blocked`: a condition failed. Its detail names it. Wait again.
- `pr_head_mismatch`: push your commits, then wait again. When you cannot push them, record a question with the refusal.
- `pr_merge_refused`, `pr_merge_unverified`, `github_uncertain`: nothing was recorded. Run the command again once. When it fails again, record a question with the refusal.

## Validate bounded corrections

After an ended internal review, make bounded corrections on the same PR and run targeted checks.
Commit and push them. Once current CI passes, run:

```sh
operator pr validate --file <plain-text-evidence|-> --json
```

Supply plain text with the correction scope and targeted validation evidence, not JSON or another round's findings.
The command requires a clean pushed worktree at the current open PR head and passing current CI.
The reviewed ready head must be an ancestor of the current head.
It records a validated head and correction summary separately; established rounds and the original reviewed ready head stay unchanged.
Merge requires this validation when the current head differs from the reviewed ready head.
Validate again if the head changes afterward.
Do not start a third broad review solely for these bounded corrections.
Validation does not supply fresh genuine GitHub approval or reopen the ended review.

## Resume the feedback loop

If your wait command is killed, run it again. Your SuperAgent sees a stopped wait until you do.

Each result is reported once, also after a restart.
When you replace an earlier owner, read the PR's reviews, comments, unresolved threads, and checks before your first wait.
Keep unlanded work in the worktree. Never delete a branch or a worktree to recover.
