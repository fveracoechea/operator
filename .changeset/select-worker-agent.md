---
"@fveracoechea/operator": patch
---

Select OpenCode's configured `worker` primary agent when dispatching WorkerAgents, including reviewers.
Session creation previously omitted the agent, so OpenCode used its default instead.
Refuse startup if OpenCode does not confirm the worker selection, while preserving the selected model, effort, and directory.
Native subagents and Claude Code launches remain unchanged.
