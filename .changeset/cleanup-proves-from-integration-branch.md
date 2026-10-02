---
"@fveracoechea/operator": minor
---

`operator cleanup remove` proves the handed-over work from the local integration branch, and it reads no remote, so a removal never waits for publish.
The checkout must be on its attempt branch at the submitted commit, or at the dispatch base for a review. Any other head, and a detached head, refuses as `head_moved`, which names both.
An accepted result passes when the integration branch is at its recorded tip and holds the recorded commit that carries the result, also after a merge landing.
A moved branch refuses as `integration_branch_moved`, a deleted branch as `integration_branch_missing`, and a landing of the same source with no recorded outcome as `landing_pending`.
A replaced commit, whose assignment was accepted through a different submission, now holds unlanded work: `cleanup remove` refuses it as `unlanded_work` with the cause `replaced`, `cleanup show` lists it under `unlanded`, and `crew next` offers no removal of it. Only the person removes it.
The `unpushed_commits` blocker is removed, and each `unlanded` entry and each `unlanded_work` blocker names its `cause`.
