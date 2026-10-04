---
"@fveracoechea/operator": patch
---

Crew state now waits for a lock that another Operator process holds while it opens the state file. Before, the open failed at once with "database is locked". A gate runner that started while the `gate run` process still held the file then left its run running with no outcome.
