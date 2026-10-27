# Review requests

A review request is a separate record for one PR. It is not an assignment and does not wait for the merge.
Review commands select the request by PR URL and run from any folder.
The PR repository must be a registered project. The CLI never reviews from your checkout instead.

```sh
operator review add <pr-url> --json
operator review start <pr-url> [--profile name] --json
operator review next --json
```

`add` records a manual request and needs no Slack tools.
`start` creates the reviewer worktree at the PR head in the repository's Herdr workspace and starts the reviewer.
The reviewer writes a draft and posts it with `operator review post <pr-url> --json`. Do not post for it.

An assignment reviewer is off by default.
`operator config apply --set review.assignments=true` queues a review request when a PR owner runs `pr associate`.
Its review is always a comment, because the owner's account cannot approve its own PR, so it never supplies the merge approval.

`review next` gives one row for each active request:

- `start_reviewer`: run the `command`. A `launch_failed` reason shows `reviewer.failure`, and a retry reopens the recorded worktree.
- `review_draft`: the reviewer works.
- `post_review` with `review_post_uncertain`: run the `command`. It finds a review that GitHub created and does not post twice. When the PR moved and GitHub has no review, the request returns to its reviewer.
- `review_watching`: the review is posted. Later rounds are not in this release.

A reviewer that reports `review_head_moved` reviewed an older head. This release does not move it to the new head. Tell the person.
This release does not clean up reviewer worktrees or local reviewer branches.
