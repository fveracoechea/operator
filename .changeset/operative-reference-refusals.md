---
"@fveracoechea/operator": patch
---

An Operative takes every fact of its attempt from its brief and from CLI results, and never opens the control reference.
A command that an Operative runs now refuses with `attempt_reference_malformed` when the control reference is not a readable file, is not JSON, is not an object, or is not complete.
The refusal names the problem and each field that has no usable value, and it no longer says that the directory carries no reference.
Each brief now states each of these refusals beside each command that can give it: `attempt acknowledge`, `attempt submit`, `question raise`, `question acknowledge`, and `review report`.
The answer that `question deliver` sends states the refusals of `question acknowledge` in the same words.
The `operative` skill tells the Operative to read only the brief and the files it names under `.operator/local/`.
