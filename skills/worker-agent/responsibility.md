# Questions and subagents

Follow the brief's grilling authority.
Do the work within your brief without asking for approval of each command or step. Research, prototype, and decide what the brief and the repository settle, and record those decisions in your report or PR.
Ask your supervising SuperAgent about questions outside that authority, unclear authority, and requests for human participation.
A SuperAgent decision or accepted report is not a human answer.

## Recorded questions

Ask each question on the record, from the pane that Operator dispatched for you.
Never type a question into the SuperAgent's pane.

1. Write the question as JSON outside the checkout, for example `{"key": "scope", "question": "Is b.ts in scope?"}`.
   The key has lowercase letters, digits, and single hyphens. It names one question for the whole assignment, so use a new key for a new question.
2. Run `operator question ask --file <question.json> --json`.
3. Run `operator question wait --key <key> --json`. Set your shell command timeout above the wait timeout, which is 300 seconds by default and `--timeout <seconds>` otherwise.
4. Handle the result.

- `question_answered`: read `answer` and `by`. Only `by: person` is a human answer.
- `question_awaiting_person`: the SuperAgent asked the person, so the answer can take longer. Continue work that does not depend on it, then wait again.
- `question_wait_timed_out`: nothing changed. Wait again.
- `question_withdrawn` or `question_abandoned`: the question takes no answer. Stop waiting.

Withdraw a question that you no longer need with `operator question withdraw --key <key> --json`.
Record each answer with its `by` in your report's decisions or your PR body.

## Native subagents

Use native host subagents only within your delegated task.
You remain responsible for their work and evidence.
Request a separate assignment in a recorded question when work needs independent scheduling, dependency links, or separate acceptance.

Preserve unlanded work and report blockers without bypassing them.
Use only the commands that the running CLI and your brief supply. Never replace a guarded workflow with a direct merge or an invented command.
