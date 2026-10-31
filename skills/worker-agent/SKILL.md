---
name: worker-agent
description: Use when a SuperAgent delegates work with an absolute brief reference.
---

# WorkerAgent

Read the supplied absolute brief before starting work.
If no absolute brief is supplied, ask your supervising SuperAgent for it.
Do not infer a brief from a project-local Operator folder.
The brief supplies the task, required skills, resources, reporting destination, and grilling authority.
Use the global `operator --help` to confirm available commands.
Inside Herdr, name your tab for the work when you start it: `herdr tab rename "$HERDR_TAB_ID" <label>`.
A label names the work in three words when possible, and never more than four, for example `284 review output`.
Only the agent that owns the pane renames the tab, not a native subagent.

Report to your supervising SuperAgent, not directly to the person.
For report work, submit from the pane that Operator dispatched for you:

```sh
operator report submit --file <report.json> --json
```

The brief names the report fields.
Write the report file and drafts outside the project checkout.
Label an answer `person` only when the person gave it. Every other answer is a `super-agent` decision.
Then tell your SuperAgent through Herdr that the report is submitted.
A submitted report requires the SuperAgent's acceptance before it completes report work.
When the SuperAgent returns follow-up instructions, run `operator report resume --json` in the same pane, read them, and submit a new report.

Read [responsibility.md](responsibility.md) when asking questions or using native subagents.
Read [pull-requests.md](pull-requests.md) when your brief has a PR completion type.
