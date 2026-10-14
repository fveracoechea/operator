# Cleanup

A review worktree stays until the user says to remove it.
After the summary, ask once: "Remove the <count> review worktrees and their branches?"

## Checks before a removal

Do these checks on each worktree in the ledger.
A worktree that fails a check stays, and you tell the user why.

- `git -C <path> status --porcelain --untracked-files=all` shows only `pr-review-result.json` and the files that setup copied.
- `git -C <path> log --oneline origin/pr/<n>..HEAD` shows no local commit.
- `herdr agent get review-<n>` shows `idle` or `done`, so the agent is not in a turn.

## Removal

For each worktree that passes the checks:

```sh
herdr worktree remove --workspace <workspace-id> --force
git branch -D review/pr-<n>
git update-ref -d refs/remotes/origin/pr/<n>
```

`--force` is necessary because the worktree holds untracked files that the checks accepted.
Remove only the workspaces, branches, and refs that the ledger names.
Then check that `git worktree list` no longer shows the path.

## Worktrees from other runs

A worktree that the ledger does not name may hold work that is not on the remote.
Remove it only when the user asks, and only when each of these is true:

- `git -C <path> status --porcelain` shows nothing.
- `git -C <path> log --oneline @{upstream}..HEAD` shows nothing, or `git branch -r --contains HEAD` shows a remote branch.
- `gh pr list --head <branch> --state all --json number,state` shows a merged pull request, or the commit is on the remote.

When a check fails, keep the worktree and tell the user what work it holds.
Remove the worktree and keep its branch, because an older session made that branch.
