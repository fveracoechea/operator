# Delegated runs without routine approval stops

Issue #61 verifies that a delegated run proceeds without per-action approval, and that the accepted human stops remain.
It adds no command, flag, or grant. Report authority is #248. The merge and cleanup stop is #251. Reset is #252. Project removal is #246.

## Human stops

The person's approved plan and the authority in its instructions cover every routine action.
These stops remain, each for its own reason:

| Stop | Where it shows | Reason |
| --- | --- | --- |
| Human participation, a question outside the authority, unclear authority | the task instructions | The person owns the goal. |
| Host trust, login, or permission prompt | a failed launch | Operator grants no host authority. |
| `person_decision` with `cleanup_unlanded_work` | `next`, then `cleanup --person-instructed` | Only the person deletes work that did not land. |
| `person_decision` with `cleanup_resource_mismatch` | `next` | Operator never removes an unrecorded path. |
| `source reset`, `project remove` | refusal `person_instruction_required` | They end work or delete history. |
| A closed PR, a missing PR worktree, a parent closed or merged outside the default branch | `owner_attention` with `pr_not_open` for a closed PR, `pr_worktree_missing`, `relay_parent_closed`, `relay_parent_base` | The recorded work cannot continue on its own. |

Registration, readiness, dispatch, worker replacement, report acceptance and return, PR feedback, the guarded merge, and cleanup retries ask no person.
The `super-agent` skill topic `delegation.md` and the worker brief state this. The `worker-agent` skill topic `responsibility.md` states it for workers.
The stale `super-agent` statement that parent-merge relay is unavailable is removed, because #250 supplies it.

## End-to-end test

`modules/operator-cli/run.delegated-run.test.ts` drives the public CLI with real Git and SQLite, an isolated device root, and the controlled Herdr and GitHub tools.
A SuperAgent loop follows only `next`. It dispatches, accepts reports, and retries cleanup. Each WorkerAgent submits its report or runs the PR feedback loop and the guarded merge.
The loop counts each `person_decision` row as a human stop and returns at it.

- On both hosts, one report and two reviewed PRs finish with zero stops. The research worker is interrupted once, and its replacement is routine. The test records the real arguments of each SuperAgent and WorkerAgent command, and none carries `--person-instructed`. Each brief states the routine authority, and both PR briefs carry the report's unresolved point.
- Unlanded work in a merged PR worktree gives exactly one stop, `cleanup_unlanded_work`. After `cleanup --person-instructed`, the loop resumes with no command, and no merge, pane close, or dispatch repeats.

## Verification

```sh
bun test modules/operator-cli/run.delegated-run.test.ts
```

Result: 3 pass, 0 fail.
The refusals of `source reset` and `project remove` without `--person-instructed` are proven in `modules/operator-cli/run.source-reset.test.ts` and `modules/operator-cli/run.projects.test.ts`, so this test does not repeat them.
Deliberate breaks: removing the brief's authority line fails the routine test on the brief assertion. Leaving unlanded work in the routine run fails it with a `cleanup_unlanded_work` stop.
The full quality gate passed: 1122 pass, 0 fail, with format, lint, typecheck, module shape, skill shape, and module boundaries clean.
