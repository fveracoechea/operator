---
"@fveracoechea/operator": minor
---

New `operator claude hook` command: a Claude Code `PreToolUse` hook that denies a `git commit` whose message has a Co-Authored-By trailer, and tells the agent to commit again without it.
`operator install --claude` adds the hook to `~/.claude/settings.json` after your own hooks, and reports it in `data.claudeHook`.
When that file or its folder is a link or read-only, for example a dotfiles link, install changes nothing and reports `claude_settings_external` with the hook entry to add.
`install --claude --check` reports `claude_hook_missing`, and `operator ready` blocks a Claude Code device until the hook is in its settings.
