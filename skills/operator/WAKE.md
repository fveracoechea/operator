# Automatic resumption after crew waits

Herdr 0.9.1 or later and Bun 1.4.0 or later are required.
Install the plugin from the Operator release that runs the CLI.
The plugin lives in that release's `herdr/` directory, outside the installed skills.
For OpenCode or Claude Code, run:

```sh
bun run operator wake plugin-path
herdr plugin link "$(bun run operator wake plugin-path)"
herdr plugin enable operator.wake
herdr plugin list --json
herdr plugin config-dir operator.wake
```

The path command resolves the checked-out or published release that runs it.
Inspect `plugin list --json` for `operator.wake`, `enabled: true`, and an empty `warnings` array.
If an earlier copy is linked, unlink it before linking the selected release's `herdr/` directory.
No project credential or Herdr configuration file is needed.
Operator stores its wake bindings in `bindings.sqlite` under the directory printed by `herdr plugin config-dir operator.wake`.
It writes a small runner file per project under that directory's `runners/` folder so Herdr can invoke the same Operator CLI release that armed the wait.

At each wait-only result, the Operator runs `bun run operator wake arm` from its own Herdr pane as described in [COORDINATION.md](COORDINATION.md).
The command records the Operator's Herdr terminal, native agent session, crew ownership revision, and the agents named by the current waits.
A pane move keeps the terminal identity, so the plugin can resolve the current pane ID.
A takeover requires the new Operator to arm a new binding after it reads `crew next`.

Herdr runs the plugin's event hook when an agent changes status.
It runs the startup hook once when a server starts or takes over.
Each hook checks `crew next` again and sends a single prompt only to an idle Operator with the recorded identity and owner revision.
The Operator reads `crew next` again before it makes any crew decision.
If Herdr reports a prompt error or exits before confirming a turn, inspect the Operator pane and the plugin log before arming again.
The plugin treats that delivery as uncertain and does not send a duplicate.

To check the installation, dispatch an Operative or reviewer through Operator, reach a wait-only `crew next`, and arm the binding.
Send a user steering message while that crew agent works and confirm that the Operator can answer it.
Then let the crew agent submit its result.
Check `herdr plugin log list --plugin operator.wake` for the event command and its `Woke Operator` output.
Confirm that the resumed Operator reads a new `crew next` result.
Run the same check with OpenCode and Claude Code as the Operator host.
To check restart recovery, leave an armed wait, restart the Herdr server by your normal session procedure, and check the plugin log for the startup command.
If the crew state needs attention while the Operator is idle, the startup command wakes it.

## Dependencies in a new worktree

The same plugin starts a dependency install in each worktree that Herdr creates, so agent hooks that run a package bin can work in the checkout.
The hook runs `bun install --frozen-lockfile` when the checkout has `bun.lock` or `bun.lockb`, and `npm ci` when it has `package-lock.json` or `npm-shrinkwrap.json`.
When the checkout has both kinds of lockfile, bun wins.
A checkout without one of these lockfiles at its root is left untouched.
The install never rewrites the lockfile, because Herdr refuses to remove a dirty checkout.
`npm ci` runs the lifecycle scripts of dependencies, and bun blocks them unless the project trusts them.
Herdr runs the hook in the background, and `herdr worktree create` does not wait for it.
Until the install ends, an agent hook that needs a package bin can still fail.
When the project runs Operator through `bun run operator`, the Operative brief still starts with `bun install --frozen-lockfile`, which covers a slow install and a machine without the plugin.
Check `herdr plugin log list --plugin operator.wake` for the install output and exit code.
