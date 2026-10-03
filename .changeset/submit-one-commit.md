---
"@fveracoechea/operator": minor
---

`operator attempt submit` reads the Operative worktree with Git and refuses a result that breaks its authority limits.
It names each refusal at once, in this order, and the first one is the reason of the result: `result_not_one_commit` when a code result is not exactly one commit on the base commit of its dispatch, `uncommitted_work` for each file that is not committed, `outside_write_paths` for each file a commit touches outside the write paths, and `result_check_not_run` for a check that could not run.
A refusal records nothing, so the attempt keeps running and its Operative can submit again.
A submission no longer names a pull request, and `pr_authority_missing` is gone.
The brief states the one-commit rule beside the submit command, with its refusal name.
The crew state moves to version 4. `operator update` refuses with `code_submission_waiting` while a code submission waits for review or acceptance, and names each one.
