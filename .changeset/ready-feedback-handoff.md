---
"@fveracoechea/operator": major
---

Start fresh PR feedback workers at guarded readiness and retain complete reviewer dispositions and optional handoff notes.
Require recorded readiness and a non-draft PR before merge.
Record person-approved skips without eagerly marking the PR ready.
The reviewer no longer remains the feedback owner after `operator pr ready`.
Ready-PR association with internal review off also hands ownership to fresh `pr-feedback`.
Stop issuing worker commands from the outgoing launch after either transition.
The successor retains the assignment and worktree, not the outgoing conversation.
Do not use an ended review, skipped review, or GitHub draft-state change as a substitute for recorded readiness.
After `operator internal-review skip --source <id> --assignment <key> --person-instructed`, the live reviewer must still run `operator pr ready`.
That skipped-review ready step needs no rounds, input file, or summary comment.
