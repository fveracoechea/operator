# Limits and the direction a user gives

Read this when a refusal names `limit_reached`, `review_attempt_limit`, or `direction_required`.

Three limits hold across sessions:

- three correction cycles on one assignment, counting `findings` and `integration` together,
- two diagnostic reruns,
- three attempts on one review, which is one reviewer and two replacements per revision.

`limit_reached` and `review_attempt_limit` both record a direction request and keep the evidence.
Acceptance then refuses with `direction_required` until the user directs the work.
Nothing is deleted, so the refusal you show the user carries every failure that led to it.

Bring that recorded evidence to the user and record their exact words as the approval it must be:

```
operator approval grant --request <id> --owner-token <token> --input <path> --json
```

The approval names four things: action `limit-direction`, the assignment as its target, the scope the refusal reported, and the revision of the direction request it answers.
The refusal prints all four.
Silence, a timeout, and a general direction to finish are not a direction.

The cycle that approval permits records it, and the brief of that cycle says so.
Once a direction is spent, reaching that limit again opens the request at the next revision.
The earlier approval then covers nothing, and the request keeps the evidence of both failures.
