# PR owners and owner attention

The WorkerAgent that owns a PR assignment keeps it through review feedback and CI.
Do not dispatch a fresh writer for each correction.
The owner opens the PR, runs `operator pr associate --json`, and then repeats `operator pr wait --json` in its worktree.
Association moves the assignment to `pr-open`, which permits dependent assignments to start.
A dependent PR assignment starts on the open parent PR's branch and targets that branch.
After the parent merges, the child owner's wait relays the child onto the default branch. `next` shows the PR's `stack` with its parent and relay state.
A PR assignment with several open parent PRs waits with `dependencies_pending` until all but one merge.

`next` shows each PR with its number, URL, and last wait state.

- `wait` with `pr_feedback_loop`: the owner is in its loop. Do nothing.
- `owner_attention` with `pr_wait_timed_out`: the owner's last wait found nothing new and the owner did not wait again. Ask the owner through Herdr for its status.
- `owner_attention` with `pr_wait_stopped`: the owner's wait process ended without a result, for example after a shell timeout. Ask the owner through Herdr to wait again.
- `owner_attention` with `pr_owner_idle`: Herdr reports the owner idle or done and no wait runs. Ask the owner for its status.
- `owner_attention` with `pr_relay_blocked`: the relay stopped at a conflict, uncommitted or unpushed work, or a failed Git or GitHub step, and kept the branch. The `stack.blocker` names the reason. Ask the owner to resolve it and wait again. A closed parent, or a parent merged outside the default branch, needs the person.
- `owner_attention` with `pr_not_open`: the PR was merged or closed outside the CLI. A merged PR completes when the owner runs `operator pr merge --json`, which verifies the merge without another merge request. For a closed PR, the assignment stays `pr-open`, and a new PR for it refuses with `pr_already_associated`. Ask the person what to do.
- `replace_worker`: the owner's pane ended or its launch failed. Inspect the recorded worktree first. A new dispatch keeps the PR, its wait progress, and the worktree, and the brief tells the replacement to read the PR before it waits.

Dispatch refuses a replacement with `pr_worktree_missing` when the PR's worktree is gone. Ask the person how to recover it.
A stuck owner whose pane is still open cannot be replaced.
Close its pane with Herdr only after you inspect the worktree, then dispatch the replacement.
A `merge_eligible` report from the owner is not a merge. The owner runs `operator pr merge --json`, which checks GitHub again. Never merge for the owner.

## Cleanup after a verified merge

The merge starts cleanup in its own process. It deletes the remote branch, closes the owner's pane, and removes the worktree in that order, and stops at the first failure.
Cleanup removes only what inspection proves landed: the worktree head must be in the merged head, and the worktree may hold only lockfile-installed `node_modules` folders and unchanged copies of `.env*.local` files from preparation.
A finished source still shows the cleanup that its merges owe.

- `wait` with `cleanup_running`: a cleanup process runs. Do nothing.
- `retry_cleanup` with `cleanup_failed` or `cleanup_stopped`: run `operator cleanup --source <id> --assignment <key> --json` from the controlling checkout, in the Herdr session that started the worker. It continues at the recorded step.
- `person_decision` with `cleanup_unlanded_work`: the detail names a remote branch that moved after the merge, or the commits, changed files, or unknown ignored content of the worktree. Ask the person. Only on the person's instruction, add `--person-instructed` to delete that work. It covers only the blocked step. A later step that finds other work blocks again with its own detail.
- `person_decision` with `cleanup_resource_mismatch`: the recorded path is no longer the recorded worktree. Operator never removes it, even with `--person-instructed`. Ask the person to move it away, then run the cleanup again.

A project with an open cleanup cannot be moved or removed.
