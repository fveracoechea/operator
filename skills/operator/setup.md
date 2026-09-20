# Project setup

Run `operator setup` with each requested agent target to inspect the project.
Show the returned changes and blockers to the user.
Apply only the exact plan ID that the user approves.
Inspect again when the plan or selected targets change.

If setup stops after a write, use the reported recovery action.
Show the exact recovery plan and apply only its approved ID.
Recovery restores setup output only when its content has not changed.
Report preserved user edits as conflicts.
