---
"@fveracoechea/operator": minor
---

The CLI now runs the project gate itself. `operator gate run` starts one gate run on a commit of a source. An Operator runner in the pane of the gate checkout of the source spawns each command from its arguments with no shell, records each outcome and its output, and wakes the Operator at the end. `operator gate show --run <id>` reports the outcome of each command and where its output is stored.
The first code dispatch of a source refuses with `gate_pending`, `gate_running`, `gate_failed`, or `gate_flaky` until its base commit passes the gate. `operator crew next` offers the new action `run_gate`, shows the new wait `gate_running`, and names the new blockers `gate_failed` and `gate_flaky`.
A failed run blocks, and a later pass at the same key makes the key flaky. Only a person starts a fresh series at a key, with an approval that names the key and each failed run.
The crew state moves to version 10. `operator update` migrates it.
