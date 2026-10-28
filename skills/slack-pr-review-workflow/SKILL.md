---
name: slack-pr-review-workflow
description: Use when watching a Slack channel for pull requests to review, or when an Operator review wait returns Slack reads or Slack effects.
compatibility: Requires Claude Code with the Slack MCP tools, Herdr (HERDR_ENV=1), and the global operator command.
---

# Slack pull request review workflow

The Operator CLI owns this workflow: the read schedule, the channel cursor, the author policy, the review requests, and every Slack text and reaction.
You only carry Slack tool calls to the CLI and back.
Do not write Slack text, change a generated text, keep a ledger, or schedule reads yourself.
The review rules live in the `pr-review` skill, and the review request rows in the `super-agent` skill, topic `reviews.md`.

The device settings name the channel, the repositories, and the GitHub authors:

```sh
operator config plan --set review.channel=<channel-id> --set review.repos=<owner/repository,...> --set review.authors=<github-login,...> --json
operator config apply <the same --set arguments> --plan <plan-id> --json
```

Without `review.channel`, the CLI reads no Slack and `data.slack` is `null`.

## The loop

Run `operator review wait --slack --json` and read `data.slack` and `data.requests` in each result.
`--slack` makes the wait end for a due read or a pending effect, and it records the channel's start cursor on the first run.
All the state is in the device database, so a new session starts here too.

1. `data.slack.read` is set: call the tool `read.tool` (`slack_read_channel`) with `read.params` unchanged. Do not add a `cursor` or a `limit`. Write the unchanged tool result to a file, then run `operator review ingest --input <file> --json`.
2. Each row of `data.slack.effects` is one Slack effect. Call its `tool` with its `params` unchanged:
   - `kind: reply`: `slack_send_message` with `channel_id`, `thread_ts`, and `message`. Change nothing in the message.
   - `kind: reaction`: `slack_add_reaction` with `channel_id`, `message_ts`, and `emoji`.

   Write the unchanged tool result to a file, then run `operator review slack-done <id> --input <file> --json`.
3. Act on the request rows as the `super-agent` skill, topic `reviews.md`, says, for example `start_reviewer`.
4. A reviewer agent that Herdr shows as `blocked`: read its pane with Herdr and tell the person what it waits for. Do not answer review questions for it.
5. Run `operator review wait --slack --json` again.

`operator review add <pr-url> --json` reviews a PR that is not in the channel, with no Slack effects.
`operator review skip <pr-url> --json` ends one PR's request on the person's instruction. A skip never names an author.

## Refusals

- `slack_effect_failed`: Slack refused the send. The effect stays pending, and the next wait gives it again. Tell the person when the same effect fails twice, for example a missing custom reaction.
- `slack_ack_unrecognized`: the result does not prove this effect: a reply needs `message_context.message_ts`, and a reaction needs `Successfully added :<emoji>: reaction`. The effect stays pending. Check in Slack, and tell the person before you send it again.
- `slack_input_unrecognized`: the input was not the raw result of `slack_read_channel`. Nothing was recorded. Pipe the unchanged result.
- `slack_cursor_moved`: another session ingested the channel first. Run `wait` again.
- `slack_not_configured`: no channel is set. Ask the person for the channel and the policy.

An acknowledgement is your claim that Slack took the effect. The CLI does not claim exactly-once delivery.
Replies post as the person, and Slack adds a `Sent using Claude` footer.
`slack_ingested_page` means Slack returned one page. The cursor stays, and the next wait gives a read with `latest` for the older messages.
The channel read holds only top-level messages, so a PR link that is only in a thread reply is not seen.
