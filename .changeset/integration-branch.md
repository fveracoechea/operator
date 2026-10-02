---
"@fveracoechea/operator": minor
---

Each source now has one integration branch, `operator/integration/<source slug>`. The first code dispatch of a source creates it at the integration base, after that base passed the project gate, and records its name, its base, and the project gate on the source. Nothing pushes it.
Every later production dispatch of the source starts from the recorded tip, so `operator attempt dispatch` takes no `--commit` for it. A `--commit` that differs refuses with `dispatch_base_not_tip`. A branch that holds another commit refuses with `integration_branch_moved` and names both tips and each worktree that has it checked out. A branch of that name that exists before the first code dispatch refuses with `integration_branch_exists`. Operator never resets or adopts a branch.
Two sources never share a source slug: an id that loses a part in the slug, by its punctuation or by the cut at 40 characters, ends with a short identity of the whole id. A branch name that another source records refuses with `integration_branch_held`.
The brief and the submit check of every attempt of the source read the project gate fixed on the source.
`operator work register` refuses a new production item with `blocker_completed_after_base` when its blocker in another source completed after the integration base was fixed.
The crew state moves to version 12. `operator update` migrates it.
