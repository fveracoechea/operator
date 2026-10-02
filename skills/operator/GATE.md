# Gate runs

Read this when `bun run operator crew next` offers `run_gate`, shows the wait `gate_running`, or a dispatch or an acceptance refuses with a `gate_` reason.

A gate run is one run of the project gate on one tree.
The CLI runs it, because an exit status that Operator code reads is a fact, and a pass that an agent reports is a claim.
Never run the gate commands yourself, and never read an outcome from pane text.

## The integration base passes first

The first code dispatch of a source fixes its integration base, so that commit passes the project gate before anything starts from it.
`crew next` offers `run_gate` for the claimed attempt in place of `dispatch_attempt`.
Run the gate on the commit you will dispatch from:

```
bun run operator gate run --request <id> --owner-token <token> --source <source id> --commit <sha> --json
```

It answers `pending` with `gate_run_started` and the run id.
The run takes no crew slot, and one gate run of a source runs at a time.
`crew next` shows the wait `gate_running` until the runner records an outcome.
Report the wait and yield as [COORDINATION.md](COORDINATION.md) describes.
The runner wakes you at the end, because a plain command fires no agent event.

When the base passes, `crew next` offers `dispatch_attempt` and names the commit.
That dispatch creates the integration branch at the commit and fixes the gate declaration on the source, as [DISPATCH.md](DISPATCH.md) describes.
Dispatch from that commit.
A dispatch from a commit with no passing run refuses with `gate_pending`, `gate_running`, `gate_failed`, or `gate_flaky`, launches nothing, and fixes no base.

## Each landing passes before it lands

A code result lands on the integration branch only after the commit it lands as passed the project gate.
That planned commit is the candidate.
When every other gate of acceptance passed, `crew next` offers `run_gate` for the assignment:

```
bun run operator gate run --request <id> --owner-token <token> --assignment <id> --json
```

The CLI plans the landing on the recorded tip and gates the planned commit.
No ref names the candidate, because the plan gives the same commit again.
Its key is its tree and the gate declaration fixed on the source.
The plan refuses as `work accept` does, for a moved or checked-out branch, a conflict, or a changed patch, and then no run starts.
A commit whose equal patch the branch already holds gates nothing, and `gate run` answers `gate_passed`, so accept it.

When the candidate passes, `crew next` offers `accept_assignment`, and a landing that has a passing run comes before a new `run_gate` of the same source.
`work accept` refuses with `gate_pending`, `gate_running`, `gate_failed`, or `gate_flaky` until then, and changes nothing.
After a landing moves the tip, every other candidate of the source is a new commit, so it is gated again.

## Where the run happens

Herdr creates one gate checkout for each source, on the branch `operator/gate/<source slug>`, beside the project root.
The runner detaches HEAD at the commit, removes every file that is not in its tree, ignored files too, and runs each command from its arguments with no shell.
The commands run in order.
After a command fails, each later command is `not-run`.
A command over its time limit is `failed` with the reason `timed-out`.
The output of each command is stored under `.operator/local/gate-runs/<run id>/`.

```
bun run operator gate show --run <id> --json
```

It reports the outcome, the exit status, and the output path of each command, and never the output text.
Read an output file only when you need the reason for a failure.

`gate run` refuses with `gate_branch_exists` when that branch already exists, because Herdr would ignore the planned commit for it.
Nothing is created, and the person decides what to do with the branch.

## A failure blocks, and only the user clears it

The key of a run is the tree of the commit and the identity of the gate declaration.
Runs are appended and never rewritten.
A key passes only with a passing run and no failed run.
A failed run blocks, and a later pass at the same key makes the key flaky, which also blocks.
Nothing reruns a gate by itself.

A failed or flaky candidate points to the result that is being accepted, because the base and every commit below it already passed.
It reaches you as `delegate_rework` with no blocker, and it names the commit and each failed run.
Delegate an integration cycle, as [REWORK.md](REWORK.md) shows. The cycle carries the failed run as a fixed artifact.
It blocks only that assignment and the dependents that wait for it.

A failed or flaky base reaches you as `run_gate` with the blocker `gate_failed` or `gate_flaky`, and it names the commit and each failed run.
Bring it to the user.
Only the user clears it:

- by a fixed main branch and a new base commit, which you then gate, or
- by an approval of a fresh series at the same key.

A fresh series needs an approval that names the key and each failed run it answers.
`gate run --approval <id>` without such an approval refuses with `fresh_series_not_approved` and gives the exact request: the action, the scope, the request revision, and the targets.
Record the user's approval with `bun run operator approval grant`, as [QUESTIONS.md](QUESTIONS.md) shows, then run `gate run --approval <id>`.
The earlier failed runs stay recorded.
A fresh series passes only with no failure inside it, so a new failure needs a new approval that names it too.
You never start a fresh series on your own judgment.

## A runner that stopped

A run with no outcome proves nothing.
The runner writes only while the owner that started the run still owns the crew, so after a takeover its next write is refused and its run keeps no outcome.
A new `gate run` replaces such a run once the pane of the gate checkout shows that the runner stopped.
While the runner still shows there, `gate run` refuses with `gate_running`, and with `gate_runner_unknown` when Herdr cannot show it.
