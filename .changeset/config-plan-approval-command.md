---
"@fveracoechea/operator": patch
---

`operator config plan` now ends with the exact `config apply` command to approve, with the same `--set` and `--unset` flags.
Only `config plan` shows that command.
When `config apply` refuses with `approval_required` or `approval_stale`, it shows the current plan and points to `config plan` again.
So the person approves each changed plan before an agent can apply it.
