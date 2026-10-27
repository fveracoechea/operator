# PR owners and owner attention

The WorkerAgent that owns a PR assignment keeps it through review feedback and CI.
Do not dispatch a fresh writer for each correction.
The owner opens the PR, runs `operator pr associate --json`, and then repeats `operator pr wait --json` in its worktree.
Association moves the assignment to `pr-open`, which permits dependent assignments to start.

`next` shows each PR with its number, URL, and last wait state.

- `wait` with `pr_feedback_loop`: the owner is in its loop. Do nothing.
- `owner_attention` with `pr_wait_timed_out`: the owner's last wait found nothing new and the owner did not wait again. Ask the owner through Herdr for its status.
- `owner_attention` with `pr_wait_stopped`: the owner's wait process ended without a result, for example after a shell timeout. Ask the owner through Herdr to wait again.
- `owner_attention` with `pr_owner_idle`: Herdr reports the owner idle or done and no wait runs. Ask the owner for its status.
- `owner_attention` with `pr_not_open`: the PR was merged or closed outside the CLI. The assignment stays `pr-open`, and a new PR for it refuses with `pr_already_associated`. This release has no CLI recovery. Ask the person what to do, because this is not a verified completion.
- `replace_worker`: the owner's pane ended or its launch failed. Inspect the recorded worktree first. A new dispatch keeps the PR, its wait progress, and the worktree, and the brief tells the replacement to read the PR before it waits.

Dispatch refuses a replacement with `pr_worktree_missing` when the PR's worktree is gone. Ask the person how to recover it.
A stuck owner whose pane is still open cannot be replaced.
Close its pane with Herdr only after you inspect the worktree, then dispatch the replacement.
Herdr activity is an observation, not a result.
A `merge_eligible` report from the owner is not a merge. The guarded merge command is not in this release.
