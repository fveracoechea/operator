# A defect found after acceptance

Read this when accepted work turns out to be wrong.

```
operator work invalidate --request <id> --owner-token <token> --assignment <id> --revision <n> --input <path> --json
```

The defect states its summary, its evidence, and who found it.
Review work is refused, because a review holds no result of its own.
The acceptance, the submission, the review, and every finding stay recorded.
The assignment returns to the frontier as `invalidated`, and you fix it as work on that assignment.

Only the dependents that read the result are paused.
`input_invalidated` at acceptance or in the frontier names the invalid result a paused assignment read.
Accepting the corrected result releases what it held.
A dependent that read two invalid results waits for both corrections.
One that was accepted returns to the step that decided it, so you take that decision again.
