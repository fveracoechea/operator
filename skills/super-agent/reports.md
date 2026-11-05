# Reports, follow-up, and acceptance

A WorkerAgent submits its report from its own pane.
`operator next --json` then shows `review_report` with the report number, its short conclusion, its unresolved points, its `reference`, and the report file.
Read the conclusion and the unresolved points first. Open the report file only when the decision needs it.

Run decisions from the registered controlling checkout, in your own Herdr pane.
The refusal of a decision from the worker's pane prevents mistakes. It does not prove who runs the command.

```sh
operator report accept --source <source-id> --assignment <key> --json
operator report return --source <source-id> --assignment <key> --file <follow-up.md> --json
```

Return specific follow-up instructions when the report is not sufficient.
After a return, `next` shows `resume_worker` when the worker is still live. Tell it in a steering message to run `operator report resume --json`, as [steering.md](steering.md) says.
It runs `operator report resume --json` and submits a new report.
When the worker stopped, `next` shows `replace_worker`. Dispatch again, and the new brief lists every earlier report and follow-up.

Acceptance completes the assignment and unblocks its dependents.
The acceptance result repeats the unresolved points. An unresolved point does not block acceptance.
Each `next` row of a dependent shows `dependencyReports` with the accepted reports of its direct dependencies, and the dependent's brief copies their conclusions, unresolved points, and references.
Decide whether a point needs other work. Operator does not schedule it. Create a tracker issue or a new plan yourself when it does.
`operator source show --source <source-id> --json` keeps every report with its unresolved points and `reference` after acceptance.
Acceptance is your decision, not a human answer, as [delegation.md](delegation.md) says.

Acceptance closes the worker pane and removes a report worktree only when Git shows no unlanded work.
A kept worktree names its reason and shows in `next` as `person_decision` with `cleanup_unlanded_work`. Only the person can authorize its deletion, so tell the person. After the person removes the work, run `report accept` again.
`retry_cleanup` means that cleanup failed or did not finish. Fix the reported cause, then run `report accept` again.
Run acceptance on the Herdr server that runs the worker, because another server cannot close its pane.

## Promotion into a PR assignment

When an accepted report concludes that its work should be built, and the report worked in a worktree, promote it at acceptance instead of registering a new source.
The PR assignment keeps the worker's context and the worktree's prototypes.

```sh
operator report accept --source <source-id> --assignment <key> --promote <promotion.json> --json
```

The file holds `key`, `trackerKey`, `instructions`, `branch`, and optional `internalReview`.
The new PR assignment depends on the accepted report and keeps the report's start profile.
Promotion refuses a pane report, an ended source, a taken key, and a report that is not awaiting acceptance. A report is promoted at most once.
Promotion keeps the pane and the worktree, renames the worktree branch to `branch`, and closes nothing.

`next: "notify_worker"` means that the worker still runs and now owns the PR assignment under a new Herdr name. Its brief was rewritten from the PR template.
`next` shows `notify_worker` with that `brief` until Herdr sees the worker work again. Tell the worker through Herdr to read the brief at that path.
`next: "dispatch"` means that the worker had stopped. `next` shows the PR assignment as `ready_assignment`, and dispatch starts it in the same worktree.
A promoted assignment follows the PR lifecycle, internal review, and reset like any other.

For another project, copy the accepted conclusion and the `reference` from the acceptance result into that project's plan instructions.
Do not depend on the producer's files, because pruning the producer removes them.
