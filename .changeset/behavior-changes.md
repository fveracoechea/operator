---
"@fveracoechea/operator": minor
---

Every `operator attempt submit` input now requires a `behaviorChanges` list, for code and non-code results. `[]` states that there is no behavior change.
Each entry is `{ statement, basis }`. The basis is the approved scope, one acceptance requirement by its position, or one answered question of the assignment whose answer is a requirement or a human answer. An Operator decision is never a basis.
Submit refuses with `behavior_change_basis_missing` when a basis does not exist, as the last check after the write paths, and names each entry.
Each axis of a result review must state `behavior-changes` in `checked`, or `operator review report` refuses with `review_coverage_incomplete`.
The brief numbers the acceptance requirements, states the basis rule beside the submit command, and the review brief lists each behavior change with its basis.
The crew state moves to version 6. A submission recorded before this release keeps no list, and its review does not require the token.
