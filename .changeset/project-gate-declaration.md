---
"@fveracoechea/operator": minor
---

A project declares its project gate in `operator-gate.json` at the repository root: an ordered list of commands, each with a unique `name`, an `argv` array, and a required `timeoutSeconds`. The release publishes its schema as `gate.schema.json`.
Operator reads the file at a commit and never from the working tree.
The new readiness check `project-gate` reports a missing or invalid file at HEAD, and it does not hold back a live probe. Setup does not write the file.
A production dispatch or replace refuses with `project_gate_missing`, `project_gate_invalid`, or `project_gate_unread` when its base commit holds no valid gate.
The producer brief lists each gate command beside the submit command and permits it. `operator attempt submit` refuses a code result with `project_gate_not_passed` when its checks do not show each gate command, by name, as `passed`.
A review brief permits the gate commands.
