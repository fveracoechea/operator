---
"@fveracoechea/operator": minor
---

Make `operator next --wait` return only the actions that its scope has not returned yet, and wait without a source from a Herdr pane on every source that the pane supervises. A wait no longer returns for an action that turned back into a wait, for a change that its own pane made, or for an owner's PR wait timeout or idle worker that clears within a minute. `next` leaves ended sources out except their prune and owed cleanup, and `operator review wait` returns only the requests its events name and those with an action. `--all` on either wait, and on `next`, returns the whole board.
