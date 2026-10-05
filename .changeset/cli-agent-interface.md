---
"@fveracoechea/operator": patch
---

An agent now reads and changes Operator configuration and state only through CLI commands.
The Operator section that setup writes in `AGENTS.md` states this rule, and it no longer names the configuration file.
It also says that an agent reads its dispatch brief, the fixed artifacts, and each file a CLI result names, and that it may write JSON requests for `--input`.
`setup plan` proposes the new section in place of the section an earlier release wrote, and the section changes only when you apply that plan.
Until then, `setup readiness` reports `instructions_missing` and names the earlier section.
`operator --version --json` now reports the selected release under `data.selection`: its `delivery`, `version`, `commit`, `packageVersion`, and the `invocation` that runs Operator in the project.
The `operator` skill uses that report to choose the invocation, and it no longer reads the release selection file.
No shipped skill names the configuration, the release selection, the readiness evidence, the control reference, the setup journal, or the crew database as a file to read.
A missing probe fixture, an unnamed host, and an invalid configuration now name the `operator config` command that sets or shows the setting.
The skills and the README call a plan file that a CLI result names a CLI output.
