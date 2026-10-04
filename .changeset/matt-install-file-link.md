---
"@fveracoechea/operator": patch
---

`install matt plan` and `install matt apply` now refuse a symbolic link at a file inside a skill folder, before any write, as they refuse a link at the skill folder.
The refusal is `upstream_unavailable` with the detail `Symbolic link in skill path: <path>`.
