# Answer pane

A longer answer gets lost in chat among the turns of parallel work.
Show an answer to the person's question in an answer pane when it holds a table or runs past about 15 lines.
The steps carry every Herdr command they need, so they need no `herdr` skill.

1. Run `command -v glow`. When it finds nothing, answer in chat and stop here.
2. Write the answer as Markdown to a new file outside the checkout, for example `${TMPDIR:-/tmp}/operator-answers/<topic>.md`.
3. Reuse your answer pane while it stays open. `herdr pane get <pane>` returns `pane_not_found` once the person closes it.
   Quit the pager of the earlier answer with `herdr pane send-keys <pane> q`.
4. Without an open answer pane, split your own pane with `herdr pane split --current --direction right --cwd "$PWD" --no-focus`.
   Split `down` instead when `herdr pane layout --current` shows a narrow pane.
   Read the pane from `.result.pane.pane_id`, and name it with `herdr pane rename <pane> answers`.
5. Run `herdr pane run <pane> "clear && glow -p <file>"`.
6. Reply in chat with one line that names the pane and the file.
