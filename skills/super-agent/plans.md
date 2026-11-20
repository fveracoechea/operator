# Plans and decisions

Write only the Task as spec plus authority, required skills, and human stops.
Copy the person's intent verbatim.
Register JSON plans with `operator source register --file <plan.json>`.
Name kinds and dependencies; kinds fix completion.
Use worktrees for changes, panes for reading.

Use `operator dispatch --kind <kind> --brief <task.md>` for one-off work; `operator ask` presets answer.
Adopt own branches as implementation, drafts as implementation/review, ready PRs as implementation/pr-feedback.
Pass `--adopt <pr-number|pr-url|branch>`; another author's PR uses review requests, never adoption.
Plans adopt PR numbers.
Preserve ownership and work; ask about resource mismatches.

Accept reports with `operator report accept`; return follow-up with `operator report return --file <follow-up.md>`.
Promotion adds PR work, not a handoff.
Submission is not completion.

Parking ends the launch, retains the worktree, and leaves dependencies unchanged until verified merge.
Resume only on the CLI's changed facts.
On the person's instruction, merge parked work through `operator pr merge --source <id> --assignment <key>`.
Approval, checks, threads, base, ready state, relay, and head still gate merge; queueing is not completion.
Assignment's own closed PR: `operator abandon`; it deletes no worktree or branch.
Follow `clean_up` with `pr_closed` to abandon without a person stop.
Ask about missing PR worktrees or parents closed/merged outside the default branch.
Only the person authorizes `cleanup --person-instructed` for unlanded work.
Ask before closing PRs.
