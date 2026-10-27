# Reports, follow-up, and acceptance

A WorkerAgent submits its report from its own pane.
`operator next --json` then shows `review_report` with the report number, its short conclusion, and the report file.
Read the conclusion first. Open the report file only when the decision needs it.

Run decisions from the registered controlling checkout, in your own Herdr pane.
The refusal of a decision from the worker's pane prevents mistakes. It does not prove who runs the command.

```sh
operator report accept --source <source-id> --assignment <key> --json
operator report return --source <source-id> --assignment <key> --file <follow-up.md> --json
```

Return specific follow-up instructions when the report is not sufficient.
After a return, `next` shows `resume_worker` when the worker is still live. Send it the follow-up path through Herdr.
It runs `operator report resume --json` and submits a new report.
When the worker stopped, `next` shows `replace_worker`. Dispatch again, and the new brief lists every earlier report and follow-up.

Acceptance completes the assignment and unblocks its dependents.
It is your decision, not a human answer, and it does not change how the report labels its answers.
Ask the person when the instructions require human participation, a question exceeds your authority, or the authority is unclear.

Acceptance closes the worker pane and removes a report worktree only when Git shows no unlanded work.
A kept worktree names its reason. Only the person can authorize its deletion, so tell the person.
`retry_cleanup` means that cleanup failed or did not finish. Fix the reported cause, then run `report accept` again.
Run acceptance on the Herdr server that runs the worker, because another server cannot close its pane.

For another project, copy the accepted conclusion and the `reference` from the acceptance result into that project's plan instructions.
Do not depend on the producer's files, because pruning the producer removes them.
