---
"@fveracoechea/operator": minor
---

`operator claude hook` now also handles Claude Code's `Stop` event as the SuperAgent's turn-end guard. It blocks the end of a turn once while the sources that the agent's Herdr pane supervises have running work and no `operator next --wait` from that pane runs. The block tells the agent to start the wait as a background command. A turn that the block continued may end, and missing or unusable device state lets the turn end.
`operator install --claude` adds a `Stop` group beside the commit hook's `PreToolUse` group. Settings that have one of the groups get only the missing one. `install --check` and `operator ready` report `claude_hook_missing` until Claude Code settings run the hook on both events, so run `operator install --claude` after the update. A linked settings file needs the `Stop` group added to its owner.
