# Limits and the direction a user gives

Read this when a refusal names `limit_reached`, `review_attempt_limit`, or `direction_required`.

Three limits hold across sessions:

- three correction cycles on one assignment, counting `findings`, `integration`, and `invalidation` together,
- two diagnostic reruns,
- three attempts on one review, which is one reviewer and two replacements per revision,
- three branch reviews that reported, on one work source, whatever changed the head between them.

`limit_reached` and `review_attempt_limit` both record a direction request and keep the evidence.
An invalidation with the budget spent records one too, and it reports the request in place of a cycle.
A fourth branch review is registered with a direction request of the scope `limit:branch_reviews`.
`crew next` offers `direct_limit` for it, and the claim refuses with `direction_required` until the user directs it.
The claim that the user permitted spends the direction.
Acceptance then refuses with `direction_required` until the user directs the work.
Nothing is deleted, so the refusal you show the user carries every failure that led to it.

Bring that recorded evidence to the user and record their exact words as the approval it must be:

```
bun run operator approval grant --request <id> --owner-token <token> --input <path> --json
```

The approval names four things: action `limit-direction`, the assignment as its target, the scope the refusal reported, and the revision of the direction request it answers.
The refusal prints all four.
Silence, a timeout, and a general direction to finish are not a direction.

The cycle that approval permits records it, and the brief of that cycle says so.
Once a direction is spent, reaching that limit again opens the request at the next revision.
The earlier approval then covers nothing, and the request keeps the evidence of both failures.
