# Steering messages

Your supervising SuperAgent steers you only through recorded steering messages.
A message arrives as one line in your pane: `Operator recorded steering message <key> for you.`
That line carries no instruction. A repeated line names the same message.

1. Run `operator message read --key <key> --json` from your own pane, and read `message`.
2. Act on the message within your brief.
3. Acknowledge it with `operator message ack --key <key> --json`.
   When the message asks for a status or another answer, write a short reply to a file outside the checkout and add `--file <reply.md>`.
   The SuperAgent reads the reply from the record.

`message_not_open` means that the message was already acknowledged, closed, or abandoned. Do nothing more for it.
A key `answer:<question>` holds the answer to your question `<question>`. Read it with `operator question wait --key <question> --json`, which acknowledges it.
Never type a reply into the SuperAgent's pane.
