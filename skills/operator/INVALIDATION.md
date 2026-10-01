# A defect found after acceptance

Read this when accepted work turns out to be wrong.

```
bun run operator work invalidate --request <id> --owner-token <token> --assignment <id> --revision <n> --input <path> --json
```

The defect states its summary, its evidence, and who found it.
Review work is refused, because a review holds no result of its own.
The acceptance, the submission, the review, and every finding stay recorded.
The assignment returns to the frontier as `invalidated`, and you fix it as work on that assignment.
Planning work that is invalidated is fixed when it is decided again with a new planning record.
`bun run operator crew next` offers it as `resolve_planning`, the crew prepares the new record, and you accept it with no attempt and with that record, as [REGISTRATION.md](REGISTRATION.md) shows.
An acceptance with no record is refused as `planning_record_required` here too, and the paused dependents stay paused.
The first record stays as it was accepted.

Only the dependents that read the result are paused.
`input_invalidated` at acceptance or in the frontier names the invalid result a paused assignment read.
Accepting the corrected result releases what it held.
A dependent that read two invalid results waits for both corrections.
One that was accepted returns to the step that decided it, so you take that decision again.
