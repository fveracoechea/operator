# Installed workflow changes

The development workflow belongs to the globally installed `implement` and `code-review` skills.
Those directories are not versioned in this checkout.
The installed files remain the instruction owners; these patches record the delivered edits for review and recovery.

`code-review-owner-proof.patch` adds direct-owner correction review to `code-review/SKILL.md`.
It applies relative to the global skills directory, against the version present before this follow-up.
Check the installed file before applying it elsewhere; a newer skill may already contain the change.

`validation-checkpoint.patch` adds the shared checkpoint topic to `implement` and points both workflow skills at it.
Apply it after the owner-proof patch.
The checkpoint uses the existing runner's budgets, cancellation, and evidence.
No local workflow authorization state exists to authenticate a human decision mechanically.
The agent must read the shared ledger and obtain that decision in the conversation.
The patches do not add production Operator assignment machinery or a mutation CI gate.

## Checkpoint review cases

Review the installed instructions against these transitions before changing them:

| Situation | Required action |
| --- | --- |
| A broad run fails after 47 seconds under a 60-second ceiling | Record 47 seconds and its evidence; close broad authorization and present the next-action checkpoint. |
| A coordinator proposes another 10-second broad run | Wait for the person's decision, despite the unused 13 seconds. |
| A worker changes worktrees or adds a wrapper | Read the same absolute ledger; retain the 47-second history. |
| A focused test diagnoses one named failure | Record its cost and stay inside the agreed scope and remaining bound. |
| The person authorizes a new cumulative ceiling | Record the reply and new ceiling; retain prior spending and reserve the next command. |
| Cancellation interrupts a campaign | Stop owned processes, confirm exit, and retain incomplete status and evidence. |

These are workflow review cases, not evidence that a text ledger authenticates human approval.
