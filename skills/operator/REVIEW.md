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
- `review_host_mismatch`: the report names a host the launch did not use.
- `review_worktree_changed`: the reviewer edited or committed in its own checkout.
  A review reads and runs checks.
  Repairing a finding is rework, and rework is a separate assignment for a fresh Operative.

A blocked or partial review accepts nothing.

A blocked review is a stopped review, not a verdict.
Correct what it names, then replace the stopped reviewer:

1. `operator attempt replace --request <id> --owner-token <token> --attempt <id> --json` reports the partial work.
2. Repeat it with `--inspection <identity>` to approve that exact reading.
3. `operator attempt dispatch` launches the replacement into the same checkout.

The replacement reads the same fixed submission and reports it itself.
One review holds at most three attempts.
`review_attempt_limit` means another launch is not a remedy on its own.
Bring the blocker to the user, and read "Limits stop a loop and ask the user" below.

## Findings are yours to judge

A finding is not an instruction.
Record each one as corrected, rejected with a reason, or deferred with a reason and a follow-up reference.

A blocker is corrected or rejected.
It is never deferred.
You may reject a finding you do not support, and the rejection states the evidence that refutes it.
You may not waive an approved requirement through technical judgment.

## A correction is delegated, never repaired here

Never edit the result yourself, and never ask the reviewer to repair what it found.
`rework_pending` at acceptance means the correction has not landed yet.

```
operator work rework --request <id> --owner-token <token> --assignment <id> --revision <n> --input <path> --json
```

The request names one reason:

- `findings`: it answers the accepted corrections of the review you name.
  Every finding of that review carries a disposition first.
- `integration`: it names the revisions it combines with the submitted result.
  Name a review only when this cycle answers that review as well.
  A review that already reported is answered either way, so its findings are never lost.
- `diagnostic`: it names the recorded checks a test infrastructure failure is suspected behind.
  At least one of them must not have passed.

State the instruction in your own words, and state each conflict the Operative must settle.
You record no resolution of your own, because that decision is the work you are delegating.

The cycle returns the assignment to the frontier.
Claim it again and dispatch it from the commit the submission recorded.
A fresh attempt is a fresh Operative, so the reviewer that found the problem never repairs it.

One cycle produces one combined revision, which registers its own review assignment.
That reviewer reads every earlier round and its dispositions, and reports a finding that came back.
Nothing between the two revisions is acceptable, so do not accept the earlier submission.

## Limits stop a loop and ask the user

Three limits hold across sessions:

- three correction cycles on one assignment, counting `findings` and `integration` together,
- two diagnostic reruns,
- three attempts on one review, which is one reviewer and two replacements per revision.

`limit_reached` and `review_attempt_limit` both record a direction request and keep the evidence.
Acceptance then refuses with `direction_required` until the user directs the work.

Bring the recorded evidence to the user and record their exact words as the approval it must be:

```
operator approval grant --request <id> --owner-token <token> --input <path> --json
```

The approval names action `limit-direction`, the assignment as its target, the scope the refusal
reported, and the revision of the direction request it answers.
The refusal prints all four.
Silence, a timeout, and a general direction to finish are not a direction.
Once a direction is spent, reaching that limit again opens the request at the next revision,
so the earlier approval covers nothing.

## A defect found after acceptance

```
operator work invalidate --request <id> --owner-token <token> --assignment <id> --revision <n> --input <path> --json
```

The defect states its summary, its evidence, and who found it.
Review work is refused, because a review holds no result of its own.
The acceptance, the submission, the review, and every finding stay recorded.
The assignment returns to the frontier as `invalidated`, and you fix it as work on that assignment.

Only the dependents that read the result are paused.
`input_invalidated` at acceptance or in the frontier names the invalid result a paused assignment read.
Accepting the corrected result releases them, and one that was accepted returns to the step that
decided it, so you take that decision again.

## Acceptance reads recorded evidence

Name the exact submission you read, and the pull request head you read.

Operator does not read the pull request itself.
It compares the head you name against the head the submission stated.
Read the live head before you accept, and name that.
Tracker reads arrive with the GitHub integration in #24.

Acceptance refuses on:

- `question_open`: the attempt still waits on an answer, so it has not finished the work.
- `submission_mismatch`: the assignment holds a different submission.
- `review_incomplete`: the review reported nothing, or it is blocked.
- `findings_undisposed`: a finding carries no disposition.
- `rework_pending`: an accepted correction is still waiting for its delegated cycle.
- `direction_required`: this assignment reached a limit and waits on the user.
- `input_invalidated`: this work read a result a defect was later found in.
- `checks_unproven`: a recorded check failed, was flaky, or did not run.
- `checks_contradicted`: a review ran a recorded check itself and saw a different outcome.
  What a reviewer ran outranks what the producer wrote about its own work.
- `pr_authority_missing`: the implementation has no pull request.
- `pr_head_required` or `pr_head_changed`: the pull request head is not the one the review saw.

A stopped reviewer process is not a review.
A passing rerun does not erase a failure.
Acceptance does not authorize merge, publication, process closure, or worktree deletion.
