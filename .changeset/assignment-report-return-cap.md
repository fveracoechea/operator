---
"@fveracoechea/operator": major
---

Limit each assignment to two report returns across replacement launches.
A third `operator report return` now refuses with `report_return_limit_reached` instead of scheduling more follow-up.
It preserves work and asks the person whether to accept, abandon, or start a new assignment.
Replacing the worker does not reset the limit.
Preserve the original report transaction refusal or Defect when staged follow-up cleanup also fails, and report the cleanup failure separately.
