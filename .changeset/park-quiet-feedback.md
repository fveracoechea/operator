---
"@fveracoechea/operator": major
---

Park quiet PR feedback waits after a 540-second default timeout while retaining the worktree.
Batch parked PR observations every 15 minutes across coordination waits.
Resume fresh feedback workers with durable events and park-only notes, including after interrupted launches.
Verify parked merges and run cleanup; preserve unlanded work when a closed PR requires abandonment.
A quiet `operator pr wait` now ends the worker launch instead of keeping that worker available indefinitely.
Checks running on the worker's pushed head keep the wait active.
Use `operator next --wait` for parked changes; do not send commands to the ended launch.

On the person's instruction, the recorded supervisor can run `operator pr merge --source <id> --assignment <key>` for a parked assignment.
The selector refuses a live worker and uses the same approval, checks, threads, default-base, relay, readiness, and head guards.
For a base that requires a merge queue, a passed gate enqueues the guarded head instead of requesting a direct merge.
Treat `pr_enqueued` as queue acceptance, not assignment completion.
The assignment remains `pr-open` and parked, with its worktree retained.
Retries check queue membership before another enqueue, including after a lost response.
Follow its `next` to `operator next --source <id> --wait`.
Only a parked batch read that verifies the merge completes the queued assignment and starts cleanup.
A merge retry that sees an already merged queued PR returns `pr_merge_awaiting_batch` until that batch records completion.
