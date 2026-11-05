# Worker questions

A WorkerAgent records a question with `operator question ask` from its own pane.
`next` shows it as `answer_question` with `question_open`, and its `question` field holds the key and the text.
An unanswered question replaces the idle-worker attention of its assignment. Answer the question instead of replacing the worker.

1. Read the assignment's instructions. They state what you may decide.
2. When the question is within your authority, write the answer to a file outside the checkout.
3. Record it with `operator question answer --source <id> --assignment <key> --key <question> --by super-agent --file <answer.md> --json`.

When the question needs the person, move it to the person first:

1. Run `operator question escalate --source <id> --assignment <key> --key <question> --json`.
   `next` then shows `person_decision` with `question_awaiting_person`, and the worker's wait returns `question_awaiting_person`.
2. Ask the person.
3. Record the person's own words with `--by person`.

Use `--by person` only for an answer that the person gave.
An answer that you infer, or one that you accept on the person's behalf, is `--by super-agent`.
Run these commands from your own pane. The worker's pane refuses them with `self_decision_refused`.
The answer reaches the worker as the steering message `answer:<question>`, which rings its doorbell. The worker reads it with `operator question wait`, so do not also type it into the worker's pane.
A question whose assignment ends is abandoned and takes no answer.
