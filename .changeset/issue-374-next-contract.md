---
"@fveracoechea/operator": major
---

Add next-step and checked-state result fields, compact migrated refusal output, and next steps on coordination and review rows.
Update consumers of assignment action and reason identifiers:

- Use `worker_attention` with `worker_idle` instead of `owner_attention` with `pr_owner_idle`.
- Replace `resume_worker` with `worker_attention`, retaining `follow_up_returned`.
- Replace `retry_cleanup` with `clean_up`, retaining `cleanup_failed` or `cleanup_stopped`.
- Replace the cleanup reason `cleanup_unfinished` with `cleanup_stopped`.
- Use `replace_worker` with `handoff_failed` instead of `retry_handoff` with `internal_review_handoff_failed` or `internal_review_handoff_stopped`.
- Use `wait` with `kind_handoff` instead of `wait` with `internal_review_handoff`.
- Without a live worker, use `replace_worker` with `worker_interrupted` instead of `owner_attention` with `pr_wait_stopped`.

Assignment rows no longer emit `owner_attention`, `resume_worker`, `retry_cleanup`, or `retry_handoff`.
They also drop the reasons `kind_not_dispatchable`, `pr_feedback_loop`, `pr_wait_timed_out`, `pr_wait_stopped`, `pr_owner_idle`, `pr_not_open`, `cleanup_unfinished`, and `internal_review_running`.
The three `internal_review_handoff` reasons also leave the assignment action set.
Use each row's `next` instead of dispatching commands from these retired identifiers.
A running handoff uses `wait` with `kind_handoff`; ordinary active PR work uses `wait` with `assignment_active`.
Parked changes use `resume_pr_feedback` with `pr_feedback`, `ci_failed`, or `pr_relay_blocked`.
A PR closed without merge uses `clean_up` with `pr_closed`, whose next command is `operator abandon --source <id> --assignment <key>`.
Abandonment preserves the worktree and branch; deleting unlanded work still requires the person's permission.
Review-request, message, and source rows are outside the ten-action assignment set.
Each scope returns renamed rows once under their new keys, without rewriting stored wait keys.

Stop parsing the former multiline refusal text.
Use `--json` for structured results, read `next` for the command or decision, and treat `state` as only the facts that refusal checked.
