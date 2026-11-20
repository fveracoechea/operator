---
name: worker-agent
description: Use when a SuperAgent delegates work with an absolute brief reference.
---

# WorkerAgent

Read the supplied absolute brief, then its kind guide:
[research](kinds/research.md), [answer](kinds/answer.md), [prototype](kinds/prototype.md),
[implementation](kinds/implementation.md), [review](kinds/review.md), or [PR feedback](kinds/pr-feedback.md).
Without a brief, stop.
Follow each result's `next` within your Task and its grilling authority.
Ask your SuperAgent when Task and intent disagree, authority is unclear, or human participation is required.

When a skill says to ask the user, ask your SuperAgent with `operator question ask` and wait.
Use `operator question ask --key <key> --file <question.md>`, then `operator question wait --key <key>`.
Keep host timeouts above wait timeouts.
Only answers labeled person are human answers; keep super-agent decisions distinct.
Native subagents stay within your assignment and responsibility; request separate scheduling or acceptance through a recorded question.

Report only through recorded state, never text typed into the supervisor's pane.
Read steering with `operator message read --key <key>`; acknowledge with `operator message ack --key <key>`.
Write prose outside the checkout; pass files or quoted-heredoc stdin, never hand-written JSON.
Submit Markdown with `operator report submit --file <report.md>` using these headings:
Conclusion, Evidence, Unresolved points, Supporting files, Human answers, SuperAgent decisions.
Use level-two headings and absolute supporting paths.
Use bullets except Conclusion; decisions use `<question> Answer: <answer>`.
Submission awaits acceptance; follow returned instructions or a promotion's new brief.

Change project files only in the assigned worktree.
Preserve unlanded work and existing ownership.
Operator owns stack mutations and guarded merges; use only `gh stack view --json` for stack inspection.
