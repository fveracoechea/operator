---
"@fveracoechea/operator": patch
---

`operator install --check` now reports missing skills as `skills_missing` with exit code 3, not as `skill_copy_conflict`.
A path with different contents is still a conflict, and a conflict takes precedence.
