---
"@fveracoechea/operator": minor
---

`operator install --opencode` now writes Operator's OpenCode plugin to `~/.config/opencode/plugins/operator.ts`. The plugin runs the new `operator opencode hook` command for the same two guards as the Claude Code hook. It refuses a shell `git commit` whose message carries a Co-Authored-By trailer, and when a SuperAgent's session goes idle while the sources its Herdr pane supervises have running work and no `operator next --wait` from that pane runs, it continues the session once for each person prompt with the reason to start the wait. The plugin finds the session's pane through Herdr, because one OpenCode server runs every session.
`install --check` and `operator ready` report `opencode_plugin_missing` or `opencode_plugin_outdated` until the plugin file carries the release's version marker, so run `operator install --opencode` after the update. A linked or unmanaged plugin file stays unchanged and reports `opencode_plugin_external`. The Nix package ships the plugin at `share/opencode/plugins/operator.ts` for consumers to link.
