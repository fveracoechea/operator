# Reviewing and accepting a result

Read this before you review a submitted result or accept an assignment.

## Order of work

1. The Operative runs `operator attempt submit` from its own worktree.
   You do not run it.
2. `operator work frontier --json` now offers the review assignment the submission registered.
3. `operator work claim` and `operator attempt dispatch` launch the reviewer, exactly as for production work.
4. The reviewer runs `operator review report` from its own worktree.
5. `operator review show --review <id> --json` gives you both reports and every finding.
6. `operator review dispose --request <id> --owner-token <token> --review <id> --input <path> --json` records your judgment.
7. `operator work accept ... --submission <id> --pr-head <sha> --json` records accepted completion.

## A submission is not completion

Exit 6 with `result_submitted` means the result is handed over, not accepted.
The assignment is now awaiting review, and its attempt has ended.

The crew slot the Operative held is free.
A one-agent crew can therefore run the reviewer at once.

## The reviewer is one crew agent

Claim and dispatch the review assignment like any other.
Start it from the commit the submission recorded.
Exit 4 with `review_base_changed` means you named a different commit, and review inputs stay fixed.

The reviewer loads the existing `code-review` skill and runs the Standards and Spec axes as native sub-agents of its own host.
Those sub-agents take no Herdr slot and no worktree.
Never start a second Herdr agent for an axis.

The reviewer needs the `code-review` skill in the checkout.
A failed `input_preparation` stage that names `code-review` means the project does not carry it.
Install it in the project and dispatch again.
Do not copy it by hand into the worktree.

## What blocks a review

- `review_axes_incomplete`: an axis is missing or reported twice.
- `review_axes_not_parallel`: the two sub-agent windows do not overlap, so the axes did not run at the same time.
- `review_sub_agent_host_mismatch`: an axis ran outside the reviewer host.
- `review_coverage_incomplete`: an axis did not state what it read.
  A code result needs the diff, the requirements, and the checks.
  A non-code result needs the artifacts, the requirements, the citations, and the provenance.
- `review_blocked`: the host could not run the axes, or a credential or input is missing.

A blocked or partial review accepts nothing.

A blocked review is a stopped review, not a verdict.
Correct what it names, then replace the stopped reviewer:

1. `operator attempt replace --request <id> --owner-token <token> --attempt <id> --json` reports the partial work.
2. Repeat it with `--inspection <identity>` to approve that exact reading.
3. `operator attempt dispatch` launches the replacement into the same checkout.

The replacement reads the same fixed submission and reports it itself.
One review holds at most three attempts.
`review_attempt_limit` means another launch is not a remedy.
Bring the blocker to the user.

## Findings are yours to judge

A finding is not an instruction.
Record each one as corrected, rejected with a reason, or deferred with a reason and a follow-up reference.

A blocker is corrected or rejected.
It is never deferred.
You may reject a finding you do not support.
You may not waive an approved requirement through technical judgment.

A correction is delegated to a fresh Operative.
Never edit the result yourself, and never ask the reviewer to repair what it found.
`rework_pending` at acceptance means that work has not landed yet.

## Acceptance reads recorded evidence

Name the exact submission you read, and the pull request head you read.

Operator does not read the pull request itself.
It compares the head you name against the head the submission stated.
Read the live head before you accept, and name that.
Tracker reads arrive with the GitHub integration in #24.

Acceptance refuses on:

- `submission_mismatch`: the assignment holds a different submission.
- `review_incomplete`: the review reported nothing, or it is blocked.
- `findings_undisposed`: a finding carries no disposition.
- `rework_pending`: an accepted correction is still waiting.
- `checks_unproven`: a recorded check failed, was flaky, or did not run.
- `pr_authority_missing`: the implementation has no pull request.
- `pr_head_required` or `pr_head_changed`: the pull request head is not the one the review saw.

A stopped reviewer process is not a review.
A passing rerun does not erase a failure.
Acceptance does not authorize merge, publication, process closure, or worktree deletion.
