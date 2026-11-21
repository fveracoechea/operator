---
"@fveracoechea/operator": major
---

Run worker kinds through one phase decision table with guarded exits and kind, phase, and next-action context on worker results.
Worker commands now refuse when their kind's required exit facts are missing.
Follow the returned `next` rather than assuming any PR or report command is valid at every phase.
PR association and new merge requests require a clean worktree; merge also requires recorded readiness.
A returned report reopens submission, not acceptance of the previous report; resume it and submit a fresh report before acceptance.
The reported work phase names the command's current phase, not proof that the worker completed earlier reasoning.
