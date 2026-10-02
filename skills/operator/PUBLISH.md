# Publish

Read this when `bun run operator crew next` offers `publish_stack`, `retarget_pull_request`, `settle_publish`, `rebase_integration`, or `settle_rebase`, or shows `stack_open` or `stack_fault`, when the user reports a merge or a close of a pull request, and when the target branch moved under a source.

The CLI publishes the integration branch of a source as a pull request stack, one pull request by default, behind one approval of the person (ADR 0022).
A person merges each pull request on GitHub.
You and the crew never merge a pull request and never turn on auto-merge.
A merge by a teammate of the person counts as the approval of the person.

## When the publish is offered

`crew next` offers `publish_stack` for a source when its records pass the publish gate:

- one branch review reported on the exact head, every finding has a disposition, no correction is pending, and its observed gate checks at the head equal the gate run at the head key;
- for a source with one code commit, the result review of that commit takes the place of the branch review;
- the integration base and every commit of the head pass the project gate at their keys;
- no invalidation, withdrawal, or direction request of the source is open.

It carries `approval_required` until the person approves a plan revision.

## Plan

```
bun run operator publish plan --source <source id>
```

The plan changes nothing: no crew record, no ref, and nothing on GitHub.
It takes no input from you.
The reviewer wrote the title, the summary, where to start reading, the merge danger, and the cut points in its report, and the CLI renders every other section of the body from the records.

The report is a summary.
It names the plan revision, the new remote branch, the target branch, the tip of the target, how far the target moved since the base, whether the head merges cleanly onto it, and each rule reading it could not verify.
Every title and body is in the file it names under `.operator/local/publish-plans/`.
Do not paste the body into the conversation.
Point the person to that file.

The plan refuses, all at once and in this order, when one of these holds:

- `branch_review_missing`, `review_findings_undisposed`, `review_correction_pending`, `branch_review_checks_missing`, `branch_review_checks_differ`: the review gate.
- `gate_base_not_passed`, `gate_commit_not_passed`: the gate records. Read [GATE.md](GATE.md).
- `invalidation_open`, `withdrawal_open`, `direction_open`.
- `nothing_to_publish`: the branch holds no commit above its base.
- `cut_not_between_commits`: a cut point that does not fall between two neighbouring commits of the head.
- `section_missing`: the review that gates the publish recorded no published text.
- `body_too_long`: a body is over 65536 characters, the GitHub limit.
- `repository_unread`, `merge_commit_not_allowed`, `signatures_required`: the repository and the rules of its default branch. A rule that the plan cannot read is shown as unverified, never as a pass.
- `remote_missing`, `remote_ambiguous`, `remote_unread`: the one remote whose URL names the repository of the source.
- `remote_name_taken`: the remote already holds the new branch name.
- `base_not_on_target`: the integration base is not an ancestor of the fetched tip of the default branch.

The target branch is the default branch of the source repository.
Part `k` gets the new remote branch `operator/<source slug>/<publication>/<k>`.

## Cut points

The Operator writes no cut point and no reason.
The branch reviewer proposes them, because it read the whole head: its report holds `published.cuts`, in landing order.
Each cut names the commit `after` which the part below ends, the `reason` for the cut, and the title, summary, start, and merge danger of the part above it.
`cuts: []` is a stack of one, the default.
A cut falls only between two neighbouring commits: a cut after a commit the head does not hold, after the head, or out of order refuses the report with `review_cut_not_between_commits`, and the plan with `cut_not_between_commits`.
The plan file shows each cut with its reason, and the person approves the cuts as part of the publish approval.
For a source with one code commit there is no cut.

The lowest pull request targets the target branch, and each higher one targets the remote branch below it.
The pull requests are created from the bottom up.
Each body covers only its own commits, says "Part `k` of `n`.", and for `k` > 1 "Based on #`m`. Merge #`m` first.", where `m` is the number of the part below.

## Approval

Ask the person to read the file and to approve the exact request the plan names:
action `publish`, the source as scope, the plan revision as request revision, and these targets:

- each new remote branch name and the target branch;
- `github:<owner>/<repo>#<n>:resolution` and `github:<owner>/<repo>#<n>:completion` for each item that closes a ticket.

The tracker steps run after the merge, and the plan file holds the text of each resolution under "Tracker steps after the merge".
When the source has a map issue, the request also names `github:<owner>/<repo>#<n>:map_amendment` for each item that closes a ticket. That step also waits for a second approval of its text after the merge.
No tracker write after the merge happens without this approval.
Record it with `bun run operator approval grant`, as [QUESTIONS.md](QUESTIONS.md) describes.
The approval binds the exact text, because the revision names every title and body.

## Apply

```
bun run operator publish apply --request <id> --owner-token <token> --source <source id> --plan-revision <revision> --json
```

The apply plans again and refuses with `plan_revision_changed` when anything that ships differs, and with `approval_required` without the approval.
Then it records the publication and each write as an intent, pushes every new name in one atomic push with no force option, and opens each pull request from the bottom up, ready for review.
It answers `published` with the pull requests.
Operator deletes no branch.

## Settle

A write whose outcome is not recorded shows as `settle_publish`.
Run the same apply again with the revision that the action names.
Each write reads GitHub first: names that are already at their commits push nothing, and a pull request whose head is the new name is found and not created again.
`publish_uncertain` means the answer was lost, so run it again.
`publish_conflict` and `publish_failed` wait on the person: a remote name at another commit, more than one pull request for one head, or a write GitHub refused.
Operator writes nothing over them.

## Merge and status

A person merges each pull request on GitHub with a merge commit, from the bottom up.
No event reaches the crew when it merges, and `crew next` never reads GitHub.
While a pull request is open, `crew next` shows the wait `stack_open` with the read to run.

Run `bun run operator publish status` when the user reports a merge or a close, or asks for the state:

```
bun run operator publish status --request <id> --owner-token <token> --source <source id> --json
```

Do not run it on every turn.
It reads each pull request from GitHub, records its state, head, base, merge commit, and merge method, and writes nothing to GitHub.
Its report is one line for each pull request.
Then run `crew next` for what follows.

After a merge commit, `crew next` offers `record_tracker` for each item of the pull request:

- The resolution takes no body: `{ "step": "resolution" }`. The CLI renders it from the merge, and a body refuses with `code_resolution_body_not_allowed`.
- The completion is `{ "step": "completion", "reason": "completed" }`. It observes the close that the closing keyword made, or closes the ticket. Another reason refuses with `completion_reason_not_approved`.
- Before the recorded merge, a step refuses with `merge_not_observed`, and nothing is written.
- The map amendment keeps its stated input. Its first record renders the exact comment to a local file, writes nothing, and refuses with `map_amendment_approval_required`. `crew next` then offers `record_tracker` with `approval_required` and names the file and the request: action `map-amendment`, the map issue as target, the assignment as scope, and the content identity as request revision. Show the person the file. After they grant that request, run the same record again. An approval of other text covers nothing. If the person rejects the text, state other text before any write, and it replaces the unsent one.
- A revoked publish approval refuses with `publish_approval_missing`, and the step carries `approval_required`.

## Retarget

After the read records a merge commit of part `k`, `crew next` offers `retarget_pull_request` for part `k+1`:

```
bun run operator publish retarget --request <id> --owner-token <token> --source <source id> --part <k+1> --json
```

It changes the base of that pull request to the target branch, under the publish approval, and changes nothing else.
It reads GitHub first, so a base that GitHub already changed answers `pull_request_retargeted` with `how: "observed"` and writes nothing.
It refuses with `retarget_not_due` before the merge of the part below, and with `stack_fault` on a part that holds a fault or above it.

## Stack faults

`publish status` answers `stack_fault`, and `crew next` offers `settle_publish` with the blocker `stack_fault`, when GitHub shows an outcome that no publication planned:

- `not_merge_commit`: a squash or rebase merge. The tracker steps of its items still run, and the resolution names the commit that landed and the method.
- `base_not_target`: a merge into a base that is not the target. It completes nothing.
- `head_moved`: the head is not the published commit, so it holds a commit that no review read.
- `closed_unmerged`: a close with no merge.

A fault on part `k` stops part `k` and every part above it: no retarget, and the fault waits on the person.
A pull request whose head a person moved gets no more writes.
Operator adopts nothing from a fault.
Bring it to the user, and run the read again when the user reports a change on GitHub.

When the person accepts a fault as GitHub shows it, record their approval of the settlement that `publish status` names under each `stack_fault` blocker: action `stack-fault`, the pull request as target, the source as scope, and the reading as request revision.
A settled squash or rebase merge counts as landed.
Any other settled fault ends its part, and the parts above it stay stopped, so `crew next` keeps `stack_fault` for them: their commits reach the target only through a new stack publication.

## Rebase onto a new base

The integration base changes only through a rebase that the person approves, so a moved target branch never changes an accepted patch by itself.
Propose a rebase in one of these cases, and only then:

- before publish, when the preview reports that the head does not merge cleanly onto the target tip, which is how an overlap with another source shows;
- before publish, when the person wants the branch on a newer target;
- after the person settled every stack fault of a publication, to drop the commits whose pull request merged and to publish the rest again.

A rebase also comes after a recall, when the recall is built.
Never propose it to follow the target on every merge.
It gates the new base and every commit again, and the new head needs a new branch review, which counts against the limit of three.

Plan it with the fetched tip of the target branch as the new base:

```
bun run operator work rebase --source <source id> --base <sha> --json
```

The plan changes nothing that others read.
Its report is a summary: the old and new base, how many commits leave the branch because their pull request merged, how many land again, how many are taken out, and the next place to gate.
Every commit is in the file it names under `.operator/local/rebase-plans/`.
Ask the person to read it and to approve the exact request it names: action `integration-rebase`, the old base and the new base as targets, the source as scope, and the plan revision as request revision.
Then `crew next` offers `rebase_integration` with the command to run:

```
bun run operator work rebase --request <id> --owner-token <token> --source <source id> --base <sha> --plan-revision <revision> --json
```

It refuses with `approval_required` without that approval, and with `plan_revision_changed` when the base or the tip moved since the plan.
It answers `gate_pending` until the new base and each commit that lands again passed the project gate, in that order.
Run the gate run it names, `bun run operator gate run --request <id> --owner-token <token> --source <source id> --base <sha> --json`, and repeat the rebase after each run, as [GATE.md](GATE.md) describes.
A failing new base is never recorded, and the refusal names the run. Only the person clears it: by a fixed target and a new base, or by a fresh series.
A commit whose new tree fails the gate is taken out by the next plan.

Then the CLI records the intent, moves the branch once, and answers `rebased`.
It is a ref move that the CLI builds only from reviewed patches, on a command you run, so it is not a change of yours, and it writes no file and nothing to GitHub.
A commit whose pull request merged into the target leaves the branch, and its ticket still completes after the merge.
A commit whose patch changes on the new base is taken out: its assignment returns to awaiting review, and `crew next` offers `delegate_rework` for an integration cycle, as [REWORK.md](REWORK.md) describes.
The rebase registers a new branch review on the new head, as [REVIEW.md](REVIEW.md) describes.
A rebase whose outcome is not recorded shows as `settle_rebase`; run the command it names again.

After the rebase, `crew next` offers `publish_stack` again when the publish gate holds.
The next publication closes each open pull request of the settled publication that it replaces: the part a settled fault left open and each stopped part above a fault.
The plan names each close, the approval names each one as `<owner>/<repo>#<n>`, and each one gets one comment that points to the replacement before it is closed with no merge. Its branch stays.
A replaced pull request whose head a person moved gets no write, no comment and no close (decision 21). The plan names it under `headMoved`; tell the user that a person closes it.

The plan refuses, all at once, with:

- `rebase_published_range`: a published pull request of the source is open, also one with a stack fault that no person settled. A rebase never changes what an open pull request holds. The person settles the fault or closes the pull request first.
- `publish_unsettled`, `landing_pending`, `rebase_pending`: settle that write, landing, or rebase first.
- `rebase_correction_open`: a correction replaces a landed commit. Accept it first.
- `rebase_take_out_pending`: the branch still holds the commit of a withdrawn item.
- `rebase_base_not_on_target`: the commit is not on the fetched target branch.
- `rebase_base_unchanged`, `rebase_base_not_ahead`: the new base is the old one, or the old base is not below it.
- `rebase_merge_not_in_base`: the new base does not hold the merge commit of a pull request that merged.
- `repository_unread`, `remote_missing`, `remote_ambiguous`, `remote_unread`, `integration_branch_moved`, `integration_branch_checked_out`, `integration_branch_unread`.

## Finished source

A source is finished when every pull request of its last publication merged with a merge commit, or the person settled its merge by another method, and every tracker step of its items is verified.
The read or the tracker step that finishes it removes its gate checkout by an unforced Herdr removal, with no approval.
Herdr refuses a checkout that holds a change, so it stays, and the report says so.
Operator deletes no branch, and a person deletes the remote branches.
