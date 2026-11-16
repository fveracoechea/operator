# Delegation and authority

Give each WorkerAgent a bounded task, the required skills, resources, completion evidence, and reporting instructions.
State who answers grilling questions and what you may decide.
Ask the person when authority is unclear, the question exceeds that authority, or the task requires human participation.
Your decision is not a human answer, even after you accept a report.

Require a short conclusion, evidence references, unresolved points, and paths to supporting files.
A stopped or idle Herdr agent is not completion evidence.
Preserve unlanded work until the person authorizes its deletion.
A report assignment completes only when you accept its report, as [reports.md](reports.md) describes.
PR assignment completion requires a verified guarded merge, not a host completion signal. [pull-requests.md](pull-requests.md) defines delivery authority.

A native subagent remains under its parent WorkerAgent's task and responsibility.
Work that needs independent scheduling, dependency links, or your separate acceptance needs its own assignment.

## Task-bounded coordination reads

Name the coordination decision before reading, then read only what settles it.
You may inspect assignment state, short reports, PR status, checks, threads, and delivery evidence across several calls.
Stop when you can dispatch, steer, accept, deliver, or ask the person a specific question.
Call count is not the boundary; substantive work and detailed investigation remain delegated.
Delegate code changes, code review, log and CI diagnosis, research, dev-server work, and browser QA.
WorkerAgents have the same MCP access as you.

Use `operator ask` for a read-only question that needs delegated investigation:

```sh
operator ask --question "<question>" --json
```

`ask` registers the question as a new source with one read-only report assignment and dispatches its worker in the same command, so it needs no plan file.
Write the question so that the worker needs nothing else: name the PR, the error, the time range, or the tool to use.
Add `--profile <name>` for an existing start profile.
The result gives `sourceId`, `assignment`, and the worker's pane.
The worker submits a report with a short conclusion, evidence with paths, and unresolved points. Accept it as [reports.md](reports.md) says.
A refused dispatch keeps the source, and its detail names the `operator dispatch` command to run again.
Work that changes project files still needs a plan with `worktree` resources, as [sources.md](sources.md) says.

Send a person's change request to the worker that owns the work, in the person's words, within the same turn.
The steering message carries it, as [steering.md](steering.md) describes.

## Open a requested URL

Only on the person's explicit request, run:

```sh
operator web open --url <http-or-https-url> --person-requested --json
```

Operator uses an appropriate local Linux `xdg-open` or macOS `open` when supported.
Remote, headless, SSH, CI, and `BROWSER` override cases return a structured capability refusal with a manual next step.
Follow that next step rather than bypassing the refusal.
The command rejects unsafe schemes, URL credentials, and control characters.
Acceptance means the opener accepted the request, not that a browser loaded the page.
For an uncertain opener result, ask the person to check their browser rather than automatically retrying.
This operation reads no page and authorizes no untrusted navigation, forms, authentication, or browser QA.
Delegate browser work separately under its own authority.

## Human stops

The person approved the plan and the authority in its instructions. That is your authority for every routine action, so do not ask the person to approve each command or step.
Registration, readiness, dispatch, worker replacement, report acceptance and return, PR feedback, guarded delivery, and cleanup retries need no separate approval.
GitHub approval remains a merge requirement, as [pull-requests.md](pull-requests.md) describes.
Decide what the instructions and the project context settle, and record the decision. Bring the person only these stops:

- The instructions require human participation, a question is outside your authority, or the authority is unclear. The person owns the goal.
- `person_decision` with `question_awaiting_person`. Ask the person, then record the answer as [questions.md](questions.md) describes.
- A new external authority, for example a host trust, login, or permission prompt. Operator does not grant host permissions.
- `person_decision` with `cleanup_unlanded_work`, and its deletion with `cleanup --person-instructed`. Only the person can delete work that did not land.
- `person_decision` with `cleanup_resource_mismatch`. Operator never removes an unrecorded path, so the person moves it away.
- `source reset` and `project remove`. They end work or delete history, so they refuse without `--person-instructed`.
- `source_supervised_elsewhere`, and `source take-over`. Another SuperAgent session supervises the source, so only the person moves it to you.
- A closed PR, a missing PR worktree, and a parent PR that closed or merged outside the default branch. [pull-requests.md](pull-requests.md) names each one.

Ask each stop as [questions.md](questions.md) describes, and keep the other work moving meanwhile.
Remind the person once. When that reminder stays unanswered, offer a fallback that needs no person, for example work that is ready now.
After the person answers, continue from `operator next --json`. Durable state keeps the progress, so do not repeat earlier steps or ask for earlier approvals again.
