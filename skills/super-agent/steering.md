# Steering messages

Steer a running worker only through a recorded steering message. Never type instructions into the worker's pane.
The CLI rings the worker's doorbell: a fixed line that names the message key and carries no instruction.

1. Write the message as JSON outside the checkout, for example `{"key": "status-1", "message": "Report your status in your reply."}`.
   The key has lowercase letters, digits, and single hyphens. It names one message for the whole assignment, so use a new key for each message.
2. Run `operator message send --source <id> --assignment <key> --file <message.json> --json` from your own session.
3. Read `doorbellFailure` in the result. Null means that Herdr took the doorbell.

The worker reads the message and acknowledges it, with a short reply when the message asks for one.

- `read_reply` with `message_replied`: read `message.reply`, act on it, then run `operator message close --source <id> --assignment <key> --key <message> --json`.
- `worker_attention` with `doorbell_failed`: Herdr refused the doorbell. Check the worker's pane, then run `operator message ring --source <id> --assignment <key> --key <message> --json`.
- `worker_attention` with `message_unacknowledged`: the worker left the message pending for 15 minutes since its last ring. Check whether the worker is in a long turn before you ring again.

A replied message, or a pending message that shows as `worker_attention`, replaces the idle-worker attention of its assignment.
A pending message inside its 15 minutes still leaves `worker_idle` or `pr_owner_idle`. Send no second message for it. Ring it again when the worker stays idle.
Close a pending message that you no longer need with `operator message close`.
A message whose assignment ends is abandoned.
An answer to a worker question is a steering message with the key `answer:<question>`, so it rings the same doorbell, and the worker's `operator question wait` acknowledges it.
