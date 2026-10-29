# Review requests

A review request is a separate record for one PR. It is not an assignment and does not wait for the merge.
Review commands select the request by PR URL and run from any folder.
The PR repository must be a registered project. The CLI never reviews from your checkout instead.

```sh
operator review add <pr-url> --json
operator review start <pr-url> [--profile name] --json
operator review wait [--timeout seconds] --json
operator review next --json
operator review skip <pr-url> --json
operator review cleanup <pr-url> --json
```

`add` records a manual request and needs no Slack tools.
To watch a Slack channel for PRs, load the `slack-pr-review-workflow` skill. It needs Claude Code with the Slack MCP tools.
`start` creates the reviewer worktree at the PR head in the repository's Herdr workspace and starts the reviewer.
The reviewer writes a draft and posts it with `operator review post <pr-url> --json`. Do not post for it.

An assignment reviewer is off by default.
`operator config apply --set review.assignments=true` queues a review request when a PR owner runs `pr associate`.
Its review is always a comment, because the owner's account cannot approve its own PR, so it never supplies the merge approval.

`review wait` watches every open request until something changes or a row needs you, then returns its `events` and the rows of `review next`.
It starts rounds, moves reviewers to new heads, sets the stale flag, and ends closed PRs by itself. Do not repeat that work.
Run it again after you act on its rows.

`review next` gives one row for each open request, and for each ended request whose cleanup did not finish:

- `start_reviewer`: run the `command`. A `launch_failed` reason shows `reviewer.failure`, and a retry reopens the recorded worktree.
- `replace_reviewer`: the reviewer stopped during a round. Run the `command`. The replacement reuses the worktree, and its brief names the earlier drafts.
- `review_draft`: the reviewer works.
- `post_review` with `review_post_uncertain`: run the `command`. It finds a review or a thread reply that GitHub created and does not post twice.
- `wait_reviews`: a reviewer move did not finish. Run `operator review wait`. `reviewer.failure` names a move that failed.
- `review_watching` and `review_approved`: the review is posted. `stale: true` means seven days without author activity. It is a flag, not a state.
- `clean_reviewer`: the reviewer cleanup failed. Run the `command` after you fix the cause.
- `reviewer_work_kept` attention: the reviewer worktree holds unlanded work. Ask the person. Only the person deletes it, then run `operator review cleanup <pr-url> --json`.

`review skip <pr-url>` ends one PR's request on the person's instruction. A skip never names an author.
