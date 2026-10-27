# Supplied assignment plans

Read the tracker with its existing tools, then supply a JSON plan to `operator source register --file <path> --json` from the registered controlling checkout.
The CLI reads no tracker.
Use the plan format and examples in the running release's `docs/implementation/244-assignment-plans.md` when working from source.

The top-level fields are `trackerKey` and `assignments`.
Each assignment supplies `key`, `trackerKey`, `instructions`, `completion`, `resources`, and `dependencies`.
`completion` is `pr` or `report`.
Use `pane` for read-only reports.
Use `worktree` and a Git `branch` name for PRs and reports that change project files.
An optional `profile` names an existing device start profile.
Dependencies name unique assignment keys within this plan.
Instructions state your delegated authority and when the WorkerAgent must ask the person.

Inspect the saved source with `operator source show --source <source-id> --json`.
Read `operator next --json`, or select one project source with `--source <source-id>`.
Use its ready candidates and waits rather than keep a second schedule.
A PR dependency permits work at `pr-open` or `merged`.
A report dependency waits for accepted `completed`, not submitted `reported`.
Plans are fixed after registration. A native subagent's work stays in its parent's assignment, and independent work needs an assignment in a new plan.

Registration launches no worker, and next actions change no state.
Start a `ready_assignment` candidate with `operator dispatch`, as [dispatch.md](dispatch.md) describes.
An empty plan ends immediately.
A repeated parent requires the prior source to have ended and gets a new source identity.
Use only workflow operations listed by the running CLI.
