---
"@fveracoechea/operator": minor
---

`operator work accept` now lands a code result on the integration branch of its source as its last step. Every other gate of acceptance passes first, then the gate run on the planned commit, then the branch moves, then acceptance is recorded. A commit whose parent is the tip lands as itself. Any other commit lands as one new unsigned commit with an equal patch, which copies the author, the committer, both dates, and the message. A commit whose equal patch the branch already holds lands nothing and is only accepted.
`--pr-head` is removed and is refused as an unknown option, and so are the `pr_head_required` and `pr_head_changed` refusals.
`operator gate run --assignment <id>` gates the planned commit of one landing. `work accept` refuses with `gate_pending`, `gate_running`, `gate_failed`, or `gate_flaky` until it passes, and with `integration_branch_moved`, `integration_branch_checked_out`, `landing_conflict`, `landing_patch_changed`, or `landing_pending` when the branch cannot take the commit. Each refusal lands nothing.
`operator crew next` offers `run_gate` for a reviewed code result, and `settle_landing` for a landing whose outcome was not recorded. Its command is a repeat of `work accept`.
Readiness refuses a Git older than 2.40.0 with `git_too_old`.
The crew state moves to version 13. `operator update` migrates it.
