---
"@fveracoechea/operator": minor
---

The CLI now owns the internal review handoff and its rounds.
With internal review on, `operator pr associate` refuses a PR that is not a draft and a worktree with uncommitted, untracked, or unpushed work.
A successful association records the review, closes the implementer's pane, and starts a fresh reviewer as the next launch in the same worktree. `next` shows the handoff and the running review as waits, a failed or stopped handoff as `retry_handoff`, and `operator handoff` repeats it.
The reviewer records each round's findings with `operator pr round --file <findings.json> --json`, which refuses a third round, a second round at the first round's head, and malformed findings.
Each launch records its resolved internal review value, and the reviewer brief comes from the recorded review instead of the PR's draft state.
A new state migration adds the review and round records. The ready step and the summary comment stay skill text for now.
