---
"@fveracoechea/operator": minor
---

New `operator next --wait [--source id] [--timeout seconds] --json`: a coordination wait that blocks until the next actions other than waits change, or until its timeout (300 seconds by default), and then returns the normal next answer with `next_actions_changed` or `next_wait_timed_out`.
Device state records the set that each scope's last wait returned, so a change between two waits returns at once, also after a restart. It also records the running wait with its process and Herdr pane.
The pane that last ran a source's wait or dispatched its work becomes the source's supervising pane. A wait without `--source` claims only open sources that no pane supervises yet.
The `super-agent` skill runs the wait as a background command between coordination steps, so worker events arrive as a new turn instead of text typed into the SuperAgent's pane.
The device database gains the `coordination_waits` table and a `supervising_pane` column on `sources`. Its migration runs once active assignments are idle, as earlier migrations do.
