# PR owners and owner attention

The WorkerAgent that owns a PR assignment keeps it through review feedback and CI.
Do not dispatch a fresh writer for each correction.
The owner opens the PR, runs `operator pr associate --json`, and then repeats `operator pr wait --json` in its worktree.
Association moves the assignment to `pr-open`, which permits dependent assignments to start.
A dependent PR assignment starts on the open parent PR's branch and targets that branch.
After the parent merges, the child owner's wait relays the child onto the default branch. `next` shows the PR's `stack` with its parent and relay state.
A PR assignment with several open parent PRs waits with `dependencies_pending` until all but one merge.
The relay and the owner's `operator pr merge` own every rebase, push, base change, and merge of a stack.
Use `gh stack view --json` only to read a stack. Run no other `gh stack` command, and ask no owner to run one.

`next` shows each PR with its number, URL, and last wait state.
Send each request to an owner as a steering message, as [steering.md](steering.md) says.

- `wait` with `pr_feedback_loop`: the owner is in its loop. Do nothing.
- `owner_attention` with `pr_wait_timed_out`: the owner's last wait found nothing new and the owner did not wait again. Ask the owner for its status in a steering message.
- `owner_attention` with `pr_wait_stopped`: the owner's wait process ended without a result, for example after a shell timeout. Tell the owner to wait again in a steering message.
- `owner_attention` with `pr_owner_idle`: Herdr reports the owner idle or done and no wait runs. Ask the owner for its status in a steering message.
- `owner_attention` with `pr_relay_blocked`: the relay stopped at a conflict, uncommitted or unpushed work, or a failed Git or GitHub step, and kept the branch. The `stack.blocker` names the reason. Tell the owner to resolve it and wait again in a steering message. A closed parent, or a parent merged outside the default branch, needs the person.
- `owner_attention` with `pr_not_open`: the PR was merged or closed outside the CLI. A merged PR completes when the owner runs `operator pr merge --json`, which verifies the merge without another merge request. For a closed PR, the assignment stays `pr-open`, and a new PR for it refuses with `pr_already_associated`. Ask the person what to do.
- `replace_worker`: the owner's pane ended or its launch failed. Inspect the recorded worktree first. A new dispatch keeps the PR, its wait progress, and the worktree, and the brief tells the replacement to read the PR before it waits.

Dispatch refuses a replacement with `pr_worktree_missing` when the PR's worktree is gone. Ask the person how to recover it.
A stuck owner whose pane is still open cannot be replaced.
Close its pane with Herdr only after you inspect the worktree, then dispatch the replacement.
A `merge_eligible` report from the owner is not a merge. The owner runs `operator pr merge --json`, which checks GitHub again. Never merge for the owner.

## Adopt an open PR

Hand an open PR that Operator did not create to a PR owner. Never carry it yourself or with native subagents.
Add a PR assignment with `adopt` set to the PR number and `branch` set to its head branch, in a new plan:

```json
{ "key": "pr-2164", "trackerKey": "github:org/repo#2164", "instructions": "Carry PR #2164 through its review to the merge.", "completion": "pr", "resources": "worktree", "branch": "feat/chat-link-widgets", "adopt": 2164, "dependencies": [] }
```

Dispatch reads the PR, puts the branch at the PR head in a new worktree, and starts the owner.
The owner's brief tells it to read the PR, its reviews, comments, unresolved threads, and checks, to associate the PR, and then to run its feedback loop.
A ready PR gets no internal review. A draft keeps the resolved setting: with internal review on, its owner associates the draft and a fresh reviewer takes over, and with it off, its owner marks the draft ready.
Dispatch refuses and changes nothing on these reasons. The detail names the PR, branch, or worktree.

- `adopt_pr_not_open`, `adopt_pr_branch_mismatch`: the PR is closed or merged, or its head is another branch or a fork. Fix the plan in a new source.
- `adopt_branch_diverged`: the local branch has commits that the PR lacks.
- `adopt_branch_checked_out`, `adopt_branch_dirty`: a worktree has the branch checked out, with uncommitted changes for `adopt_branch_dirty`.
- `adopt_pr_unreadable`, `adopt_branch_unavailable`: GitHub or Git did not answer. Dispatch again.

Unlanded work belongs to whoever made it. Ask the person to push or move it, or to remove the worktree, then dispatch again.

## Internal review

An internal review is on by default for each PR assignment, and an assignment, a plan, or `review.internal` can turn it off.
With it on, the implementer opens a draft PR and associates it. Associate refuses a PR that is not a draft and a worktree with uncommitted, untracked, or unpushed work.
The association records the review and starts the handoff in its own process: it closes the implementer's pane and dispatches a fresh reviewer into the same worktree.
The reviewer owns the PR until its merge, and its brief makes it the reviewer from the recorded review.
Send the reviewer no account of the implementer's work. Its inputs are the issue, the assignment instructions, and the diff.

- `wait` with `internal_review_handoff`: the handoff runs. Do nothing.
- `wait` with `internal_review_running`: the reviewer reviews the draft. Do nothing. Once it marks the PR ready and waits on it, `next` shows the PR feedback loop.
- `retry_handoff` with `internal_review_handoff_failed` or `internal_review_handoff_stopped`: the handoff could not close the implementer's pane, or its process ended before the reviewer started. Run `operator handoff --source <id> --assignment <key> --json` from the controlling checkout, in the Herdr session that started the implementer. It skips each finished step.
- `replace_worker` with `launch_failed` after a handoff: the reviewer's start failed. Dispatch it as any replacement. The new launch is the reviewer.

`next` shows the assignment's `internalReview` with its state, its recorded rounds, its handoff, and, after it ends, its `readyHead` and summary `comment`.
The reviewer ends the review with `operator pr ready`, which posts the one summary comment and marks the PR ready.
The guarded merge refuses until the review ended `ready` or `skipped`, so ask nobody to approve the PR while it is a draft.
With `review.assignments` on, the end of the review queues the assignment reviewer, so `review next` shows `start_reviewer` only for a ready PR.
A `replace_worker` after the review ended starts the PR owner. Its brief says how the review ended.

To skip a running internal review, on the person's instruction only, run `operator internal-review skip --source <id> --assignment <key> --person-instructed --json` from the controlling checkout.
It marks the PR ready with no comment and records the skip. The reviewer keeps the PR as its owner, and its next `operator pr round` or `operator pr ready` refuses with `internal_review_ended`.
A draft associated before this release has no recorded review, so its replacement owner's brief does not make it the reviewer. Tell that owner in a steering message to mark the draft ready with `gh pr ready`, then to run its PR feedback loop.

## Cleanup after a verified merge

The merge starts cleanup in its own process. It deletes the remote branch, closes the owner's pane, and removes the worktree in that order, and stops at the first failure.
Cleanup removes only what inspection proves landed: the worktree head must be in the merged head, and the worktree may hold only lockfile-installed `node_modules` folders, unchanged copies of `.env*.local` files, and unchanged files that the preparation install wrote.
A finished source still shows the cleanup that its merges owe.

- `wait` with `cleanup_running`: a cleanup process runs. Do nothing.
- `retry_cleanup` with `cleanup_failed` or `cleanup_stopped`: run `operator cleanup --source <id> --assignment <key> --json` from the controlling checkout, in the Herdr session that started the worker. It continues at the recorded step.
- `person_decision` with `cleanup_unlanded_work`: the detail names a remote branch that moved after the merge, or the commits, changed files, or unknown ignored content of the worktree. Ask the person. Only on the person's instruction, add `--person-instructed` to delete that work. It covers only the blocked step. A later step that finds other work blocks again with its own detail.
- `person_decision` with `cleanup_resource_mismatch`: the recorded path is no longer the recorded worktree. Operator never removes it, even with `--person-instructed`. Ask the person to move it away, then run the cleanup again.

A project with an open cleanup cannot be moved or removed.
