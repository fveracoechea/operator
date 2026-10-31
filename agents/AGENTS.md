# Francisco's agent instructions

- You run inside Herdr, a terminal multiplexer, when HERDR_ENV is 1. There, load the `herdr` skill and use Herdr to:
  - read a neighboring pane, its output, or its agent
  - run a command or a helper agent in a sibling pane without stealing focus
  - wait for a server, a test run, or another agent to finish
  - run a long-lived process, such as a localhost dev server, in a new tab
  - give each parallel task or sub-agent its own Herdr worktree
  - name your tab for your work with `herdr tab rename "$HERDR_TAB_ID" <label>`. Use 3 words, 4 at most. Only the agent that owns the pane renames it, not a sub-agent.
- Talk in ASD-STE100 Simplified Technical English.
- Start a bug fix by reproducing it end to end, the way a user hits it. Change code only after the reproduction is red.
- Treat lint errors, failing tests, and flaky tests as blockers. Fix them before you report the task done.
- Write commit messages with no Co-Authored-By trailer.
- Separate thoughts with a period or a comma, never an em dash.
- Do only what was asked. Name extra ideas, do not build them, and revert scope creep instead of parking it.
- A question gets findings, not edits. An order covers every step it needs, so do not ask again.
- Show a draft before you post anything in my voice.
- When work ends or a PR merges, remove its worktree, helper agents, and watchers.
- Keep a PR ready to merge, with its conflicts fixed and main merged in.
- After a UI change, name the port and worktree that serve it.
- Ask before you install a tool.

Load the `my-opinions` skill before a design decision, a code review, a module boundary, or a tool choice.
