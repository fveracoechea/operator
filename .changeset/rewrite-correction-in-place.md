---
"@fveracoechea/operator": minor
---

The acceptance of a correction of a landed commit rewrites the integration branch in place. The correction takes the place of the landed commit, each later commit lands again with an equal patch after it passed the project gate at its new place, and the branch moves once. A later commit whose patch changes, that fails the gate, or that needs a commit taken out returns to awaiting review and lands again on the tip later. A correction now starts at the landed commit. Cleanup refuses with `rewrite_pending` while a rewrite has no recorded outcome, and a withdrawal refuses while a landing or rewrite intent moves the commit of the item. The crew state moves to version 17.
