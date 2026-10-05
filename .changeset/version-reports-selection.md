---
"@fveracoechea/operator": patch
---

`operator --version` now also shows the release that the project selected.
`operator --version --json` reports it under `data.selection`.
A selected release has its `delivery`, `version`, `commit`, `packageVersion`, and `invocation`.
The `invocation` is the command that runs Operator in the project.
