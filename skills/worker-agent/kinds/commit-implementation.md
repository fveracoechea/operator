# Commit implementation

Implement the task in the isolated ticket worktree. Do not create a PR or push main.
Commit intermediate work normally, preserving configured identity, signing and hooks.
Do not add Co-Authored-By trailers.

Run `operator commit review --json` when the worktree is clean.
Operator pins a single-parent candidate and starts a fresh reviewer from recorded facts.
Stop after the handoff. Preserve all implementation history.
