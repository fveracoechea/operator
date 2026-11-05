---
"@fveracoechea/operator": minor
---

WorkerAgents no longer send text to their SuperAgent's pane, so a worker update can no longer land in the middle of a prompt that the person is typing.
The `worker-agent` skill and the assignment and reviewer briefs drop every step that told a worker to message its SuperAgent.
A submitted report, a draft PR ready for internal review, a started merge, and a posted review now reach the SuperAgent only through `operator next --wait` or `operator review wait`.
A worker that meets a refusal it cannot fix records a question with `operator question ask`.
A PR brief now puts the conclusion, evidence, and unresolved points in the PR body.
`bun run lint:skills` fails when a line of the `worker-agent` skill tells a worker to message its SuperAgent.
