---
"@fveracoechea/operator": major
---

Require a worker kind in new assignment plans instead of an explicit completion type.
Resolve kind defaults, preserve launch snapshots, and link the six installed kind guides in worker briefs.
Update each new plan assignment to name `kind`, such as `research` or `implementation`, and remove its explicit `completion` field.
The kind fixes completion; plans can still override resources and start profiles.
Install the matched owned guides and their required upstream skills before dispatch, then check `operator ready --json`.
Older assignments follow the separate in-flight kind mapping and explicit kind-fill rules.
