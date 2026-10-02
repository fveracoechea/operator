---
"@fveracoechea/operator": minor
---

A person withdraws a registered item by removing its issue from the parent.
The next `operator work register --plan` lists each recorded item that the read does not find under `withdrawals`, with its state and its recorded landing, and counts it as `withdrawn`.
The withdrawal is recorded only under the person's `registration-change` approval of the exact plan revision, and Operator writes nothing to the tracker for it.
The plan refuses while an attempt of the item or of a review of its result is active (`withdrawal_attempt_active`), while a tracker step of the item has no recorded outcome (`withdrawal_effect_unsettled`), and while a recorded dependent still names it as a blocker (`withdrawal_dependent_pending`).
`withdrawn` is a terminal assignment state: it never satisfies a dependency, the frontier lists it under `withdrawn`, and a claim of it is refused as `assignment_withdrawn`.
Its open cycle, open invalidation, open direction request, and each review of it that no attempt holds close with it, and its history stays.
A withdrawn issue added to its parent again is refused as `withdrawn_item_readded`, and a new link to withdrawn work as `blocker_withdrawn`.
The refusal `recorded_item_missing` is removed.
A registration now reports only `counts` of the registered, updated, and withdrawn assignments and the command `operator work frontier`, and no longer lists each assignment.
`operator cleanup remove` refuses a checkout of withdrawn work that holds a commit as `unlanded_work`, and `operator cleanup show` lists it under `unlanded`. Only the person removes it.
The crew state moves to version 11, which records the plan revision of each withdrawal.
