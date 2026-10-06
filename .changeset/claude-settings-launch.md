---
"@fveracoechea/operator": patch
---

A Claude Code Operative now starts with any number of write paths and allowed commands.
Dispatch writes the allow list to `.operator/local/claude-settings.json` in the worktree and passes `--settings <file>` in place of `--allowedTools <entries...>`.
The launch line has the same length for every brief, so it stays inside the 1024-byte terminal input limit of macOS.
The permissions do not change: `dontAsk`, the same allow list, and no permission prompt.
The launch identity covers the settings content, so a recovery starts with the same permissions.
