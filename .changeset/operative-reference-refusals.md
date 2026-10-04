---
"@fveracoechea/operator": patch
---

An Operative takes every fact of its attempt from its brief and from CLI results, and never opens the control reference.
A command that an Operative runs now refuses a control reference that is not JSON, not an object, or not complete with `attempt_reference_malformed`.
The refusal names the problem and each field that has no usable value, and it no longer says that the directory carries no reference.
Each brief now states `attempt_reference_malformed` and `attempt_reference_mismatch` beside its acknowledge command, next to `attempt_reference_missing`.
The `operative` skill tells the Operative to read only the brief and the files it names under `.operator/local/`.
