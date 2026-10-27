# Delegation and authority

Give each WorkerAgent a bounded task, the required skills, resources, completion evidence, and reporting instructions.
State who answers grilling questions and what you may decide.
Ask the person when authority is unclear, the question exceeds that authority, or the task requires human participation.
Your decision is not a human answer, even after you accept a report.

Require a short conclusion, evidence references, unresolved points, and paths to supporting files.
A stopped or idle Herdr agent is not completion evidence.
Preserve unlanded work until the person authorizes its deletion.
A report assignment completes only when you accept its report, as [reports.md](reports.md) describes.
PR assignment completion requires the owner's guarded merge, not a host completion signal.

A native subagent remains under its parent WorkerAgent's task and responsibility.
Work that needs independent scheduling, dependency links, or your separate acceptance needs its own assignment.

## Human stops

The person approved the plan and the authority in its instructions. That is your authority for every routine action, so do not ask the person to approve each command or step.
Registration, readiness, dispatch, worker replacement, report acceptance and return, PR feedback, the owner's guarded merge, and cleanup retries need no approval.
Decide what the instructions and the project context settle, and record the decision. Bring the person only these stops:

- The instructions require human participation, a question is outside your authority, or the authority is unclear. The person owns the goal.
- A new external authority, for example a host trust, login, or permission prompt. Operator does not grant host permissions.
- `person_decision` with `cleanup_unlanded_work`, and its deletion with `cleanup --person-instructed`. Only the person can delete work that did not land.
- `person_decision` with `cleanup_resource_mismatch`. Operator never removes an unrecorded path, so the person moves it away.
- `source reset` and `project remove`. They end work or delete history, so they refuse without `--person-instructed`.
- A closed PR, a missing PR worktree, and a parent PR that closed or merged outside the default branch. [pull-requests.md](pull-requests.md) names each one.

After the person answers, continue from `operator next --json`. Durable state keeps the progress, so do not repeat earlier steps or ask for earlier approvals again.
