---
"@fveracoechea/operator": minor
---

After you upgrade, run `setup plan` and apply the plan.
Until you apply it, `setup readiness` reports `instructions_missing` and names the earlier Operator section of `AGENTS.md`.
`setup plan` proposes the new section in place of the section that an earlier release wrote.
The new section tells an agent to read and change Operator configuration and state only through CLI commands.
It no longer names the configuration file.
It says that an agent reads its dispatch brief, the fixed artifacts, and each file that a CLI result names.
It also says that an agent may write JSON requests for `--input`.
