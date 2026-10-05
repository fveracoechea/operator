---
"@fveracoechea/operator": patch
---

`attempt dispatch` no longer refuses a launch because crew work changed an Operator-owned skill that the project tracks.
Before, a result that edited a tracked skill copy made every later launch at that commit fail at `input_preparation` with `skill_copy_conflict`, so the result could not be reviewed and no later production dispatch could start from the integration branch.
Now a launch keeps a committed copy that changed after the integration base, and the launch snapshot and the brief name it.
A copy that already differs at the integration base still refuses, so a copy that a person changed is never replaced.
