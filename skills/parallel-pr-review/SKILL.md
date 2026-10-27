---
name: parallel-pr-review
description: Use when reviewing several pull requests at once, one agent per pull request, or a pull request stack, and summarizing the verdicts or posting them to Slack.
compatibility: Requires Herdr (HERDR_ENV=1), the gh CLI, and the global operator command.
---

# Parallel pull request review

Each pull request gets one review request and one reviewer in its own Herdr worktree.
Operator starts the reviewers, and each reviewer writes a draft with the `pr-review` skill.
Only `operator review post` posts a review, so this skill holds no review rules and posts no review.
GitHub is the source of truth, and an agent report is a claim.

## Inputs

- Pull requests, as URLs, with optional short titles. Keep the order.
- Optional Slack target, a thread URL or a channel. Without one, skip step 5.

Each repository must be a registered project on this device.
An unregistered repository refuses with `review_repository_unregistered`. Tell the user, and do not review it from your own checkout.

## 1. Add and start the requests

For each pull request, run:

```sh
operator review add <pr-url> --json
operator review start <pr-url> --json
```

`start` fetches the PR head, creates a reviewer worktree on a local branch in the repository's Herdr workspace, and starts the reviewer with its brief.
Operator never pushes a reviewer branch.
A pull request that is not open refuses with `review_pr_not_open`. Tell the user.

## 2. Wait for the posts

Run `operator review next --json` and read one row for each active request.

- `wait` with `review_draft`: the reviewer works. Wait for its Herdr report.
- `action` `start_reviewer`: the start failed or was not run. Read `reviewer.failure`, then run the `command`.
- `action` `post_review` with `review_post_uncertain`: GitHub did not confirm a post. Run the `command`. It looks for the review first and does not post twice.
- `wait` with `review_watching`: the review is posted.
- An approved request leaves the list.

For a `blocked` reviewer, read its pane with Herdr.
Answer only setup and check questions. Give the rest to the user.
A reviewer that reports `review_head_moved` reviewed an old head. This release cannot move the reviewer to the new head, so tell the user.

## 3. Verify on GitHub

Each post result and each `review` field in `next` gives the event and the review URL.
Open each URL and confirm the review on GitHub. If GitHub differs, use the GitHub values and note it.

## 4. Summarize

One lead line with the verdict count and shared facts, then one bullet per pull request in the user's order.
A bullet is a review link, the short title, and the top one or two points.
Put the verdict at the front of each bullet only when verdicts differ.

```markdown
All 3 reviews are posted. **2 PRs need changes.**

- [#1486](https://github.com/<owner>/<repo>/pull/1486#pullrequestreview-5523325175) shell: the narrow layout reads the window width, not the stage pane.
```

In the terminal only, add notes: reviewers that needed a nudge, GitHub mismatches, and refused posts.

## 5. Post to Slack (optional)

Do this step only when the user gave a Slack target. Post the summary without the notes.
Load `slack:slack-messaging`, then post with `slack_send_message` and `channel_id`.
For a thread, add `thread_ts`. The thread URL `.../archives/<channel_id>/p1792003966909819` gives `1792003966.909819`.
Give the user the link of the posted message.

## 6. Reviewer worktrees

Operator records each reviewer worktree and branch in device state.
This release does not clean them up. Leave them, and tell the user which worktrees remain.
