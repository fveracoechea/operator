# The CLI lands each accepted commit, and the integration branch moves only from its recorded tip

`operator work accept` lands a code result on the integration branch of its source as the last step of acceptance.
Every other gate of ADR 0007, and a passing gate run on the planned commit (ADR 0021), pass first, then the branch moves, and then acceptance is recorded.
So the branch never holds a commit that failed another gate, and acceptance never refuses after a commit is on the branch.
A commit that the branch already holds with an equal patch lands nothing, and its acceptance is only recorded.

The CLI lands a commit itself, with no worktree and no edit.
When the parent of the reviewed commit is the tip, the branch moves to that commit.
Otherwise the CLI merges the change of the commit onto the tip, with the parent of the commit as the merge base, and makes a new commit with the author, the committer, both dates, and the message of the reviewed commit, and no signature.
The landed commit is therefore known before the branch moves, and a repeat gives the same commit.
The move is one staged effect under ADR 0005: its intent names the tip it moves from and the commit it moves to, and the branch moves only if it still holds that tip.
Recovery reads the branch once: the old tip means the move did not happen, the planned commit means it did, and anything else is a moved branch.

A landing needs the same patch, as ADR 0015 records.
The patch is the change with its usual context lines and its whitespace, from one canonical diff that detects no renames.
This strict patch never refuses a normal landing, because two results in flight never touch the same file.
That holds only because of two other rules: the frontier holds the write paths of unaccepted work (ADR 0004), and a result that touches a file outside its write paths, on either side of a rename, is refused at submit (ADR 0018).
If either rule becomes weaker, this identity must be chosen again.

A conflict, a changed patch, or a planned commit that failed the project gate lands nothing and records nothing.
The Operator then delegates an integration cycle under ADR 0008.
The cycle plans the landing again, refuses if the commit would now land cleanly and no failed or flaky gate run exists at its planned commit, and names the submitted commit and the commit it lands on as the revisions it combines, with the failed gate run when there is one.
A fresh Operative makes one new commit on that tip, and it is a new submission with its own result review, as ADR 0017 records.

The integration branch is a local branch of the shared repository, in a namespace of its own, and its name is recorded on the source when it is created.
Its base is the commit that the first code dispatch of the source names, and that base changes only through a rebase onto a new base that a person approves (ADR 0022).
Every later production dispatch of the source starts from the recorded tip, so its base holds every result it depends on.
An invalidated assignment whose commit is on the branch starts at that commit instead, and its base is the parent of that commit there, because its correction takes the place of that commit.
Nothing pushes the branch before publish, and publish pushes its commits under new remote names, with the user's approval and never with force (ADR 0022).

A branch that moved outside this protocol stops every landing, rewrite, and production dispatch of its source, and a branch that a worktree has checked out stops every landing and rewrite.
The refusal names the tip that was recorded and the tip that was found, or the worktree.
Operator never resets or adopts a moved branch; a person puts it back.

A correction of a landed commit is rewritten in place.
When the correction is accepted, the CLI rebuilds the branch in the same order: the corrected commit takes the place of the old one, and each later commit lands again if its patch is still equal, no result it depends on was taken out, and it passed the project gate at its new place (ADR 0021).
A later commit that fails any of these tests is taken out of the branch and paused as a consumer of the corrected result under ADR 0008.
Its acceptance is taken again later as an ordinary landing on the tip.
If its patch is equal, it lands with no new review; if not, it becomes an integration cycle.
The branch moves once, from the old tip to the rebuilt one.
This check of every later commit replaces a separate check that corrected commits share no file, and it finds more: a correction and a later commit that no correction targets.

A withdrawal of a landed commit (ADR 0016) is the same rewrite with no replacement.
`operator work take-out` rebuilds the branch of one source in the same order without every withdrawn commit that it still holds, and each later commit lands again under the same three tests.
A later accepted commit that fails a test is taken out and returns to awaiting review, not to a pause, because no correction will come to release it; a later commit that is not accepted keeps its state.
While a take-out waits, the branch holds a commit that no assignment owns, so the frontier offers no production work of that source (ADR 0004).
The take-out is its own command, because a registration reads only the tracker and never moves a branch, and acceptance records accepted completion, which a withdrawal is not.

A commit inside a published pull request of the stack is never rewritten in place.
A rewrite or a take-out whose position is inside an open published range refuses and names that pull request until the range is recalled, and a new stack publication follows (ADR 0022).
A commit that landed after the last publish is rewritten locally like any other.

## Considered options

An integration assignment kind for an Operative was rejected.
Each landing would take a crew slot and a Herdr agent for a step with no judgment, the branch would get a second kind of writer, and the CLI would still have to prove the patch afterwards.

Integration by the Operator agent by hand was rejected.
The Operator holds no worktree of its own (ADR 0008), and a hand step leaves no record to recover from.

A landing at submission, before review, was rejected.
Later dispatches would start from unaccepted commits, and every refused acceptance would rewrite the branch under them.

A separate landing command before acceptance was rejected.
It makes "landed and not accepted" a real state between two commands, and ADR 0015 already rejected a separate integrated state.

A patch identity with no context lines was rejected.
The reviewer would no longer read the exact patch that lands, and with the write-path hold the strict identity costs nothing.

A hidden reference in place of a branch was rejected, and so was a branch only on the remote.
Every Git tool reads a plain local branch, and a remote-only branch makes every landing a network write.

A push after each landing was rejected.
A push writes where other people read, and one push path at publish is less to keep correct.

A base recorded at registration was rejected, because registration reads only the tracker.
A base that follows the main branch by itself was rejected, because the rebase that follows it changes patches that were already accepted.
A rebase that a person approves goes through the rewrite, so a patch that it changes becomes an integration cycle (ADR 0022).

A committer of the current user at the current time was rejected.
The landed commit would be known only after the move, so recovery could not name what it expects.

Adopting a moved branch as the new tip was rejected, because it puts unreviewed commits under later work.
Resetting it was rejected, because it deletes work of a person.

An integration cycle that the refused acceptance opens by itself was rejected.
A refused command changes nothing, and delegating a cycle, with the conflicts it names, is the Operator's judgment.

A correction as a new commit on top was rejected.
The corrected assignment would own two commits, and its first commit would still fail the gate on its own.
A fixup on top with a squash before publish was rejected for the same reason, and because every dispatch until publish would start from a commit that no assignment owns.

A rewrite that waits until every later commit it disturbs has a new reviewed revision was rejected.
The disturbed commits would stay accepted while a newer revision waits, which is a second integrated state; the rebuilt history would sit on no branch; the defect would stay under new work until the slowest of those reviews ends; and one acceptance would land several assignments.

A rewrite of a published range with a force push was rejected.
Other people already read what was published.

A take-out inside `operator work accept` was rejected.
That command would then record an outcome that is not accepted completion, so one command would have two meanings.
A take-out inside the registration was rejected, because a registration reads only the tracker.

A revert of a withdrawn commit, as a new item, was rejected.
The pull request would hold a commit and its revert, and every reader would read the change twice.

## Consequences

A landing runs no check, because it has no worktree.
The project gate runs on the planned commit before the move, in a checkout of its own, as ADR 0021 records.

A fast-forward landing keeps the commit identity of the Operative, and a merge landing gives a new identity with an equal patch.
A rewrite gives every later commit a new identity, so a link to a commit is written only after the last change of the branch.

A landed commit carries no signature of the user, and publish pushes it unsigned.
Publish refuses a target branch that requires signed commits (ADR 0022), and how Operator would sign is not decided.

Two sources that share code are one source, or they run one after the other, as ADR 0016 records.

The crew state records the integration branch of each source, its base, its recorded tip, and each landing with its intent and outcome, so the state version moves with the migration that ADR 0015 already requires.
Each landing also names the commit on the branch that carries its accepted result, and a landing that lands nothing names the commit that already holds the equal patch.
A rewrite updates that commit for every result it lands again, because removal of a checkout proves the accepted result from it (ADR 0010).
A landing whose outcome was not recorded is a recovery action of the next actions, ahead of new work, as ADR 0011 orders recovery.

Operator now needs a Git version that can merge without a worktree, and readiness refuses an older one.

The integration branch is named `operator/integration/<source slug>`.
Two sources never share a slug: a source id that loses a part in the slug, by its punctuation or by the cut at 40 characters, ends with a short identity of the whole id.
A name that another source records refuses with `integration_branch_held`, so no source loses its record.
The first code dispatch creates it at the integration base, after that base passed the project gate, and only if no branch of that name exists, so a branch that a person made is never taken over and refuses with `integration_branch_exists`.
That dispatch records the name, the base, the recorded tip, and the gate declaration on the source in the same step as its launch plan.
A later production dispatch of the source names no commit, and a `--commit` that differs from the recorded tip refuses with `dispatch_base_not_tip`.
A rework cycle and a review keep their own start.
A moved branch stops each production dispatch with `integration_branch_moved`, which names both tips and each worktree that has the branch checked out.
A source that an earlier release dispatched records no branch, and its later dispatches keep the commit that the caller names.

The module `integration-branch` is the only Operator code that writes a Git ref itself, and `lint:modules` refuses the plumbing command that writes a ref in every other production module.
Herdr still creates the branch of each checkout that it creates.

`operator work accept` has no option that names a commit, and the former `--pr-head` option is refused as unknown.
A landing refusal names its cause: `integration_branch_moved` with both tips, `integration_branch_checked_out` with the worktree, `landing_conflict` with the paths, `landing_patch_changed`, `landing_tip_changed` when another acceptance moved the recorded tip after the plan was made, `landing_pending` while another landing of the source has no recorded outcome, and `integration_branch_missing` for a source that records no branch.
Each one lands nothing and records nothing.
The patch identity hashes the plumbing diff with three lines of context, no rename detection, and full binary content, so no user setting changes it.
A landing whose outcome was not recorded is offered as `settle_landing`, right after `reconcile_attempt`, and its command is a repeat of `work accept`.
A findings cycle and a diagnostic rerun start on the earlier submitted commit, so the patch of their result runs from the base of the first submission of that chain, and it lands as one commit, as an amended commit would.
A correction of a landed commit starts at the commit that its landing recorded, and the Operative makes one commit on top of it.
Its reviewed change runs from the parent of that commit, so the commit that takes the place of the landed one carries the landed change and the correction together.
An integration cycle of a correction starts from the parent of the replaced commit, the commit its result lands on.

The rewrite is a landing of the kind `rewrite`, and its intent records the whole plan: the landing it replaces, each later landing that lands again with its new commit and parent, and each later landing that is taken out with its cause (`patch-changed`, `conflict`, `gate`, or `dependency`).
The later landings, and the results each one depends on, are read from the crew state, and the plan refuses when Git does not hold them above the replaced commit in the same order.
`crew next` offers `run_gate` for the first commit of the rebuilt range that has no passing run, one commit at a time, and the plan is made again after each run.
A later commit whose new tree failed or is flaky is taken out by the next plan, so only the changed part of the range is gated again.
When every commit of the range passed, `work accept` records the intent, moves the branch once from the old tip to the rebuilt tip, and records the outcome with the acceptance: the replaced landing ends, each later landing names its new commit, and each one taken out ends and returns its assignment to awaiting review.
An interrupted rewrite is settled by `settle_landing` like any other landing, and while it waits, cleanup refuses each checkout of the source with `rewrite_pending` and a withdrawal of a result it moves refuses with `withdrawal_effect_unsettled`.
The rewrite is a ref move that the CLI builds only from reviewed patches, on a command that the Operator runs, so it is not an Operator change (`CONTEXT.md`, **Operator**).
A rewrite whose replaced commit a recorded stack publication holds refuses with `rewrite_published_range` and names the pull request, because no recall is recorded yet.
A rewrite that would return a result to awaiting review while a tracker step of that result is recorded refuses with `rewrite_tracker_recorded` and names each step.
Since ADR 0022, a code result completes only after its merge, so its commit is inside a published range, and only a state that an earlier release recorded holds such a step; its ticket would say the work is done while its commit leaves the branch, so a person decides, and Operator writes no tracker step to undo another one.

The take-out is a landing of the kind `take-out`, and its intent records the same plan with no correction: the lowest withdrawn commit is the replaced one, each other withdrawn commit is removed with it, and the plan names the registration plan revision that recorded the withdrawals.
`operator work take-out --source <id> --plan-revision <revision>` is bound to that revision (D5): a revision that did not record each withdrawal refuses with `take_out_plan_changed`, so the move is exactly the one the person approved, and the registration plan already listed each later commit that it lands again (`rebuilds`), read from the crew state.
Each take-out is bound to one revision, so a registration that withdraws more landed work while a take-out of the source waits refuses with `take_out_pending`, and `work accept` of a code result of the source refuses with `take_out_pending` too, so the rebuilt range stays the one the plan listed and no landing is gated twice.
`crew next` offers `run_gate` with `operator gate run --source <id>` for each commit that lands again, then `take_out_commit`, and the command refuses with the gate blockers of ADR 0021 until the range passed.
The record ends each withdrawn landing as taken out, moves the recorded tip, and registers the branch review when the branch became final (ADR 0017); the withdrawn commit stays in its checkout, which only the person removes (D3).
A withdrawn landing on a commit that a result that is not withdrawn also carries leaves the record only, because that commit stays on the branch.
An interrupted take-out is offered as `settle_landing` with the same command.
Readiness refuses a Git older than 2.40.0 with `git_too_old`, because Git 2.40.0 is the first release that has both `merge-tree --merge-base` and `patch-id --verbatim`.
