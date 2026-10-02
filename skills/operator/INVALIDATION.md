# A defect found after acceptance

Read this when accepted work turns out to be wrong.

```
bun run operator work invalidate --request <id> --owner-token <token> --assignment <id> --revision <n> --input <path> --json
```

The defect states its summary, its evidence, and who found it.
A corrected branch finding invalidates its target through this same path, inside `review dispose`, so you do not run `work invalidate` for it.
Its defect carries the finding, its target commits, and your reason, as [REVIEW.md](REVIEW.md) shows.
Review work is refused, because a review holds no result of its own.
The acceptance, the submission, the review, and every finding stay recorded.
The assignment returns to the frontier as `invalidated`, and the invalidation opens its correction cycle in the same change.
The cycle carries the defect, the accepted submission, and the landed commit, so you write no rework input and do not run `work rework`.
Claim it and dispatch it with no `--commit`.
A code correction starts on the parent of the landed commit, because it takes the place of that commit, and `correction_base_changed` means you named another commit.
The cycle counts against the same budget of three as every other correction cycle.
When that budget is spent, the invalidation still records the defect and pauses its dependents, and it records a direction request in the same change.
The frontier then withholds the dispatch with `direction_required` until the user answers, as [LIMITS.md](LIMITS.md) shows.
After the user answers, the claim opens the cycle under that approval.
Planning work that is invalidated opens no cycle, and it is fixed when it is decided again with a new planning record.
`bun run operator crew next` offers it as `resolve_planning`, the crew prepares the new record, and you accept it with no attempt and with that record, as [REGISTRATION.md](REGISTRATION.md) shows.
An acceptance with no record is refused as `planning_record_required` here too, and the paused dependents stay paused.
The first record stays as it was accepted.

Only the dependents that read the result are paused.
`input_invalidated` at acceptance or in the frontier names the invalid result a paused assignment read.
Accepting the corrected result releases what it held.
A dependent that read two invalid results waits for both corrections.
One that was accepted returns to the step that decided it, so you take that decision again.
