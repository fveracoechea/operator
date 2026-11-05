---
"@fveracoechea/operator": minor
---

SuperAgents now steer WorkerAgents on the record.
`operator message send` records a keyed steering message for a running worker and types a fixed doorbell line that names the key into the worker's pane. The line carries no instruction.
The worker reads the message with `operator message read` and acknowledges it with `operator message ack`, with an optional `--file` reply.
`operator next` shows a reply as `read_reply` until `operator message close`, and a message whose doorbell failed or that stays pending for 15 minutes as `worker_attention`. `operator message ring` rings a pending message again.
An answer to a worker question now reaches the worker as the steering message `answer:<question>`, which rings the worker's doorbell, and `operator question wait` acknowledges it.
A pending or replied message is abandoned when its assignment ends.
A promoted report's kept worker now gets the steering message `promoted` for its new brief, and `next` no longer shows `notify_worker`.
The state migration adds the `worker_messages` table, and the `super-agent` skill replaces its steps that typed requests into a worker's pane with steering messages.
