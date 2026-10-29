# Supplied assignment plans

Read the tracker with its existing tools, then supply a JSON plan to `operator source register --file <path> --json` from the registered controlling checkout.
The CLI reads no tracker.

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
Plans are fixed after registration. Independent work needs an assignment in a new plan.

Registration launches no worker, and next actions change no state.
Start a `ready_assignment` candidate with `operator dispatch`, as [dispatch.md](dispatch.md) describes.
An empty plan ends immediately.
A repeated parent requires the prior source to have ended and gets a new source identity.

## Reset and prune

Reset a source only when the person tells you to end it. Never reset on your own decision, and never infer the instruction from a plan or from permission for other work.
Run `operator source reset --source <source-id> --person-instructed --json` from the controlling checkout.
`--person-instructed` attests the person's instruction. It does not grant authority.
Reset refuses with `source_worker_running` while a worker of the source runs or starts. The detail names each pane. Close that pane in Herdr, so that the Operator Herdr plugin records its end, then reset again. Run `operator herdr install` first when the plugin is missing or from another release.
It refuses with `source_ended` for a finished or reset source.
Reset keeps merged PR assignments and completed reports, and marks every other assignment `abandoned`.
It removes no worktree, branch, or pane, closes no PR, and changes no tracker content.
The result lists `retained` work of the abandoned assignments: each worktree that still exists, its branch, and each PR without a verified merge. Tell the person about each one.
After a reset, register the same parent again with a new plan when the person wants new work. The new source has a new identity and adopts nothing from the old one.

`next` shows `source_ended` with `endedAt` and `prunableAt` for an ended source, and `prune_source` once 14 days have passed.
Run `operator source prune --json` to delete every eligible ended source of the project, with its briefs, reports, and supporting files.
There is no archive. Copy report content that another project needs into that project's plan before the producer is pruned.
A source with an open cleanup or a running worker stays, and its `retry_cleanup` or `person_decision` row stays in `next`.
The result lists the `retained` worktrees, branches, and unmerged PRs of each pruned source, because prune never removes them. Tell the person, because no Operator record of them remains.
`source_prune_failed` keeps the source records, so `prune_source` stays in `next`. Prune stops at that source, and later sources wait for the next run. Resolve the reported path or I/O problem, then prune again.
