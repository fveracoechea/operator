---
"@fveracoechea/operator": patch
---

Dispatch and reviewer starts now use an open project workspace that Herdr gives no checkout for, when each of its panes is in the controlling checkout. Operator creates a project workspace only when none is open.
Operator labels the tab of each new or reopened worktree with the launch name. Before, the tab showed only its number.
The `super-agent` and `worker-agent` skills tell an agent to name its own Herdr tab for its work, in three words when possible and never more than four.
