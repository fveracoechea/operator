---
"@fveracoechea/operator": major
---

Keep three event-driven waits. Coordination now owns review upkeep instead of a separate review command.
Replace the removed `operator review wait` command with `operator next --wait`.
`operator review next` remains available for a nonblocking review read.
The remaining waits are `operator next --wait`, `operator pr wait`, and `operator question wait`.
All default to 540 seconds and accept longer whole-second `--timeout` values.
Set an explicit timeout if a caller depends on the previous default.
A quiet coordination or question timeout prints one line whose next step repeats that wait.
Use `--json` when a caller needs the structured timeout result.
A question's person-escalation notice returns once, then its wait continues until an answer or an end.
Coordination waits return new review actions and events, not every unchanged review request.
An explicit `--source` scope includes only that source's assignment review requests; `--all` changes the returned board, not wake conditions.
