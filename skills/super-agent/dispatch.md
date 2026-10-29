# Dispatch and launch attention

Run `operator herdr install --json` once per device.
It writes one stable Herdr plugin manifest in device state and links it.
Its hooks call the global `operator` command.
It refuses to replace another plugin with the same id.

Dispatch a ready candidate from the registered controlling checkout:

```sh
operator dispatch --source <source-id> --assignment <key> --json
```

Run it in a pane of the Herdr session that holds the project workspace.
Outside a Herdr pane, dispatch refuses with `herdr_session_required`.
`herdr_plugin_outdated` means that the linked manifest is from another release. Run `operator herdr install --json` again.
Dispatch checks static readiness and the plugin, then resolves the assignment's start profile for this launch.
Report work with `pane` resources gets a new tab in the project workspace and no worktree.
Work with `worktree` resources gets a new Herdr worktree that Herdr places.
The plugin prepares every new worktree of a registered project before the WorkerAgent starts.
The WorkerAgent receives one prompt with the absolute device-state brief.

A taken name or branch gets a numbered suffix.
Operator never adopts, overwrites, or deletes an unrecorded pane, branch, or worktree.

`next` shows the latest launch of each started assignment.
A `replace_worker` action with `launch_failed`, `launch_abandoned`, or `worker_interrupted` permits one new dispatch of that assignment.
`launch_abandoned` means that the dispatch process stopped before it recorded an outcome.
`launch_starting` means that a live dispatch process still starts the worker. Wait for it.
The replacement resolves current settings, keeps earlier launch records, and reopens a recorded worktree.
A reopened worktree whose preparation did not finish is prepared again before the WorkerAgent starts.
Inspect the recorded pane or worktree before you replace a worker.

`worker_attention` with `worker_idle` means that Herdr reports the live worker `idle` or `done`, and the worker has no PR and no submitted report.
Ask the worker for its status through Herdr.
A host can report idle during a long command. Ask before you close the pane.
If it cannot continue, for example after it lost its context, close its pane with `herdr pane close`.
`next` then shows `replace_worker` with `worker_interrupted`, and the replacement reopens the recorded worktree with its partial work.
Dispatch refuses while the worker is live.

A host trust, login, or permission prompt is host configuration.
Herdr refuses a blocked startup, and dispatch records the launch as failed.
Ask the person to change host configuration, for example to let the host read Operator device state.
Operator does not answer host prompts or install permission rules.
