---
"@fveracoechea/operator": patch
---

Dispatch and reviewer starts now find an open project workspace by its panes when Herdr gives the workspace no checkout.
Each pane must be in the controlling checkout or in a folder below it. Operator creates a project workspace only when none is open.
Operator labels the root tab of a new project workspace with the repository name, and the root tab of each new or reopened worktree with the launch name. Before, these tabs showed only a number.
The `super-agent` and `worker-agent` skills tell an agent to name its own Herdr tab for its work, in three words when possible and never more than four.
