---
"@fveracoechea/operator": minor
---

`operator work invalidate` of executable work now opens its correction cycle in the same change.
The brief of that cycle carries the defect, the accepted submission, and the landed commit, and its dispatch starts on the parent of the landed commit.
A dispatch that names another commit refuses with `correction_base_changed`.
The cycle counts against the shared budget of three correction cycles.
An invalidation that finds that budget spent still records the defect, pauses what read it, and records a direction request, and the claim after the user answers opens the cycle.
A direction that the user already gave no longer withholds a dispatch or appears as `direct_limit`.
Planning work opens no cycle.
