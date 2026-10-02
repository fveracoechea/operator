# Reviewing and accepting a result

Read this before you review a submitted result or accept an assignment.

## Order of work

1. The Operative runs `bun run operator attempt submit` from its own worktree.
   You do not run it.
2. `bun run operator crew next --claude --json` now offers the review assignment the submission registered,
   before any new production work.
3. `bun run operator work claim` and `bun run operator attempt dispatch` launch the reviewer, exactly as for production work.
4. For a JSR selection, the reviewer runs `bun install --frozen-lockfile` and then `bun run operator review report` from its own worktree.
   For a source selection, it uses the pinned source invocation in [SKILL.md](SKILL.md).
5. `bun run operator review show --review <id> --json` gives you both reports and every finding.
6. `bun run operator review dispose --request <id> --owner-token <token> --review <id> --input <path> --json` records your judgment.
7. `bun run operator work dispose --request <id> --owner-token <token> --submission <id> --input <path> --json` records a disposition on each outside change.
8. `bun run operator work accept ... --submission <id> --pr-head <sha> --json` records accepted completion.

## A submission is not completion

Submit reads the Operative checkout and refuses a result that breaks its authority limits, for example with `result_not_one_commit`.
It also refuses with `behavior_change_basis_missing` when a behavior change names a basis that does not exist.
A code result is also refused with `project_gate_not_passed` when its checks do not show each project gate command, by name, as `passed`.
Submit reads the gate at the base commit of the attempt, so the producer cannot choose the gate that scores it.
The reviewer is permitted to run the gate commands, and no reviewer outcome stands in for a gate run.
The attempt then keeps running, and its Operative fixes the result and submits again.
You do nothing for that refusal.

Every submission lists its behavior changes, and `[]` states that there is none.
Submit checks only that each basis exists.
The reviewer checks that the list is complete and that each basis permits its change.

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

The review brief gives `code-review` its inputs: a spec copy fixed at submission, the base commit as the fixed point, and the read-only `git` commands it may run.
You do not pass the reviewer any of these yourself.

The reviewer needs the `code-review` skill in the checkout.
A failed `input_preparation` stage that names `code-review` means the project does not carry it.
Install it in the project and dispatch again.
Do not copy it by hand into the worktree.

## What blocks a review

- `review_axes_incomplete`: an axis is missing or reported twice.
- `review_axes_not_parallel`: the two sub-agent windows do not overlap, so the axes did not run at the same time.
- `review_sub_agent_host_mismatch`: an axis ran outside the reviewer host.
- `review_coverage_incomplete`: an axis did not state what it read.
  A code result needs the diff, the requirements, the checks, and the behavior changes.
  A non-code result needs the artifacts, the requirements, the citations, the provenance, and the behavior changes.
  The token `behavior-changes` states that the axis read the list.
  A missing or wrong entry is a blocker finding, and the usual disposition and rework path handles it.
- `review_blocked`: the host could not run the axes, or a credential or input is missing.
- `review_host_mismatch`: the report names a host the launch did not use.
- `review_worktree_changed`: the reviewer edited or committed in its own checkout.
  A review reads and runs checks.
  Repairing a finding is rework, and rework is a separate assignment for a fresh Operative.

A blocked or partial review accepts nothing.

A blocked review is a stopped review, not a verdict.
Correct what it names, then replace the stopped reviewer:

1. `bun run operator attempt replace --request <id> --owner-token <token> --attempt <id> --json` reports the partial work.
2. Repeat it with `--inspection <identity>` to approve that exact reading.
3. `bun run operator attempt dispatch` launches the replacement into the same checkout.

The replacement reads the same fixed submission and reports it itself.
One review holds at most three attempts.
`review_attempt_limit` means another launch is not a remedy on its own.
Read [LIMITS.md](LIMITS.md), which says what the user has to settle before a fourth one runs.

## Findings are yours to judge

A finding is not an instruction.
Record each one as corrected, rejected with a reason, or deferred with a reason and a follow-up reference.

A blocker is corrected or rejected.
It is never deferred.
You may reject a finding you do not support, and the rejection states the evidence that refutes it.
You may not waive an approved requirement through technical judgment.

Never edit the result yourself, and never ask the reviewer to repair what it found.
Read [REWORK.md](REWORK.md) before you delegate a correction, a combined revision, or a diagnostic rerun.

## Outside changes wait for a disposition

Dispatch scans the folder that holds the worktree and the controlling checkout before the Operative starts.
Submit scans them again, and it records each difference on the submission as an outside change.
Submit never refuses for one, because the scan cannot name the writer.

`operator review show` lists each outside change with its id, its place, and its path.
`operator crew next` offers `dispose_outside_changes` after the findings are disposed.
Give each change one disposition:

```json
{
  "dispositions": [
    { "changeId": "<id>", "disposition": "explained", "reason": "<why>", "evidence": "<what shows it>" },
    { "changeId": "<id>", "disposition": "removed" }
  ]
}
```

Never delete an outside change yourself, and never ask an Operative to delete it.
Only the user deletes it.
`removed` passes only when a new scan finds the entry as it was before the attempt.
`outside_change_not_removed` means the scan still finds it.

A change in `.git/hooks/` or `.git/config` of the checkout touches a security permission, so the user decides it.
Its action carries the `approval_required` blocker.
`outside_change_approval_missing` gives the exact approval to bring to the user: the action `outside-change-keep`, the path, the submission, and the change id.
A change marked `unscanned` is a scan that could not run, which is never a pass.

## Acceptance reads recorded evidence

Never accept a result you reviewed yourself.
A submitted result goes to a separate reviewer, and a review report is never a submitted result.


Name the exact submission you read, and the submitted commit that the review read.

A code result is one commit and names no pull request.
Acceptance compares the commit you name against the commit the submission recorded.
Tracker reads arrive with the GitHub integration in #24.

Acceptance refuses on:

- `question_open`: the attempt still waits on an answer, so it has not finished the work.
- `submission_mismatch`: the assignment holds a different submission.
- `review_incomplete`: the review reported nothing, or it is blocked.
- `findings_undisposed`: a finding carries no disposition.
- `rework_pending`: an accepted correction is still waiting for its delegated cycle.
- `outside_changes_undisposed`: an outside change carries no disposition.
- `direction_required`: this assignment reached a limit and waits on the user.
  Read [LIMITS.md](LIMITS.md).
- `input_invalidated`: this work read a result a defect was later found in.
  Read [INVALIDATION.md](INVALIDATION.md).
- `checks_unproven`: a recorded check failed, was flaky, or did not run.
- `checks_contradicted`: a review ran a recorded check itself and saw a different outcome.
  What a reviewer ran outranks what the producer wrote about its own work.
- `pr_head_required` or `pr_head_changed`: name the submitted commit that the review read with `--pr-head`.

A stopped reviewer process is not a review.
A passing rerun does not erase a failure.
Acceptance does not authorize merge, publication, process closure, or worktree deletion.

Read [INVALIDATION.md](INVALIDATION.md) when accepted work later turns out to be wrong.
