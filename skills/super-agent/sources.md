# Supplied assignment plans

Read the tracker with its existing tools, then supply a JSON plan to `operator source register --file <path> --json` from the registered controlling checkout.
The CLI reads no tracker.

The top-level fields are `trackerKey` and `assignments`, with optional `intent` and `internalReview`.
Each assignment supplies `key`, `trackerKey`, `instructions`, `completion`, `resources`, and `dependencies`.
`completion` is `pr` or `report`.
Use `pane` for read-only reports.
Use `worktree` and a Git `branch` name for PRs and reports that change project files.
An optional `profile` names an existing device start profile.
Dependencies name unique assignment keys within this plan.
An optional top-level `maxRunning` caps the plan's assignments with a starting or live worker, including PR owners in their feedback loop and internal reviewers.
Leave it out unless the person asks to protect CI minutes or the device on a large plan.
Instructions state your delegated authority and when the WorkerAgent must ask the person.
An optional `intent` on the plan or on an assignment holds the person's own words for the work. An assignment's `intent` wins over the plan's.
Copy the person's words verbatim into `intent`. Put your interpretation, scope, and build steps in `instructions`.
The brief shows `intent` as the acceptance criteria, and the internal reviewer judges the Spec axis against it.

Inspect the saved source with `operator source show --source <source-id> --json`.
Read `operator next --json`, or select one project source with `--source <source-id>`.
Use its ready candidates and waits rather than keep a second schedule.
A PR dependency permits work at `pr-open` or `merged`.
A report dependency waits for accepted `completed`, not submitted `reported`.
While the cap is reached, each ready assignment of the plan is a wait with `running_cap_reached` and its `runningCap`, and dispatch refuses it with the same reason.
A `replace_worker` action is never held, so a replacement continues started work even above the cap.
A recorded merge or accepted report frees its place, also while its pane and worktree close.
Plans are fixed after registration. Independent work needs an assignment in a new plan.
Promotion of an accepted report is the one exception. It adds one PR assignment, and next actions and reset include it. Read [reports.md](reports.md).

Registration launches no worker, and next actions change no state. A wait records only the set it returned.
Start a `ready_assignment` candidate with `operator dispatch`, as [dispatch.md](dispatch.md) describes.
An empty plan ends immediately.
A repeated parent requires the prior source to have ended and gets a new source identity.

## Coordination wait

WorkerAgents reach you through recorded state, never through text in your pane.
`operator next --wait --json` blocks until the set of next actions other than waits changes, then returns the normal next answer with `next_actions_changed`.
It returns `next_wait_timed_out` with the unchanged answer after `--timeout <seconds>`, 300 by default.
Select one source with `--source <source-id>`. Each scope compares against the set that its last wait returned, so a change between two waits returns at once.
A scope that never returned a set returns at once.
The pane that last ran the wait or dispatched a source's work supervises that source. A wait without `--source` claims only open sources that no pane supervises yet, so run it from your own pane.

Run the wait as a background command, so its result arrives as a new turn and never mixes with the person's typing:

- Claude Code: the Bash tool with `run_in_background`.
- OpenCode: the shell tool's background mode.

Keep the host's command timeout above the wait timeout.
Handle each result, then start the next wait before you end your turn.
On Claude Code, the turn-end guard blocks the end of a turn once while your pane's sources have running work and no wait from your pane runs. Its reason tells you to start the wait. OpenCode has no guard, so this rule is yours to keep.
While a wait runs, the person can still prompt you. Answer, and leave the wait running.
A host without background commands runs the wait in the foreground when the person asks you to watch.

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
