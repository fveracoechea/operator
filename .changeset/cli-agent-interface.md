---
"@fveracoechea/operator": patch
---

An agent now reads and changes Operator configuration and state only through CLI commands.
The Operator section that setup writes in `AGENTS.md` states this rule.
It no longer names the configuration file.
It says that an agent reads its dispatch brief, the fixed artifacts, and each file that a CLI result names.
It also says that an agent may write JSON requests for `--input`.
`setup plan` proposes the new section in place of the section that an earlier release wrote.
The section changes only when you apply that plan.
Until then, `setup readiness` reports `instructions_missing` and names the earlier section.
`operator --version` now also shows the release that the project selected.
`operator --version --json` reports it under `data.selection`.
A selected release has its `delivery`, `version`, `commit`, and `packageVersion`.
It also has its `invocation`, the command that runs Operator in the project.
The `operator` skill uses that report to choose the invocation.
It no longer reads the release selection file.
No shipped skill names the configuration, the release selection, the readiness evidence, the control reference, the setup journal, or the crew database as a file to read.
A missing probe fixture, an unnamed host, and an invalid configuration now name the `operator config` command that sets or shows the setting.
The probe fixture message also names the flags that `operator config apply` takes.
`operator config plan` now ends with the exact `config apply` command to approve, with the same `--set` and `--unset` flags.
In `--json` results, a missing configuration and a configuration that needs recovery now give a `nextAction`.
The skills and the README call a plan file that a CLI result names a CLI output.
In `--json` results, readiness next actions and the probe fixture credential now name the command that runs the selected release.
The other commands already do this.
