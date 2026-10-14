# The summary

The summary is one lead line and one bullet for each pull request, in the order that the user gave.
The user reads it in a few seconds.

## Shape

- The lead line gives the verdict count and the facts that all the pull requests share, for example "Lint, typecheck and tests pass on all of them".
- Each bullet starts with a link to the review, labeled with the pull request number.
- Then the short title that the user gave, or a short form of the GitHub title.
- Then one sentence with the top one or two points, taken from `blockers`, or from `nice_to_haves` when there is no blocker.
- When all the pull requests have the same verdict, the lead line says it once and the bullets do not repeat it.
- When the verdicts are different, each bullet starts with the verdict: "Approved", "Changes requested", or "Commented".
- Shared noise goes in the lead line once, not in each bullet.

```markdown
All 12 reviews are posted. **Every PR has changes requested.** Lint, typecheck and tests pass on all of them.

- [#1486](https://github.com/<owner>/<repo>/pull/1486#pullrequestreview-5523325175) shell: the narrow layout reads the window width, not the stage pane, and every status chip is green.
- [#1496](https://github.com/<owner>/<repo>/pull/1496#pullrequestreview-5523310135) Inventory empty: it says "No line items" with no check. Fold it into #1512 or change the copy.
```

## Notes for the user

Give the summary in the terminal, then add notes on each of these that occurred:

- An agent that did not post, needed a nudge, or was blocked.
- A mismatch between an agent report and GitHub.
- A pull request that got `COMMENT` because the user is its author.
- Each `left_out` finding, with an offer to add it to the review.
- Shared noise, with the files that cause it.

The notes stay in the terminal, and the Slack post carries only the summary.

## Slack

Post only when the user gave a target.
Load the `slack:slack-messaging` skill before you write the post, and format the links as it says.

A thread URL has the shape `https://<workspace>.slack.com/archives/<channel-id>/p<digits>`.
The `thread_ts` is the digits with a dot before the last six, so `p1792003966909819` is `1792003966.909819`.
Read the thread before you post, and match the summary to what the thread asks.
Post with `slack_send_message` and give `channel_id` and `thread_ts`.
For a channel target, post with `channel_id` only.

Report the link of the posted message to the user.
