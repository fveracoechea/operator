---
"@fveracoechea/operator": patch
---

`operator crew next` now names the submitted commit in the `dispatch_attempt` action of a review and of a findings or diagnostic rework.
The `command` reads `operator attempt dispatch --attempt <id> --commit <sha>`, and the `detail` names the same commit.
Before, the action named no commit, `attempt dispatch` with no `--commit` refused with `commit_required`, and the Operator had to read the commit from Git.
