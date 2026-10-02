# Publish

Read this when `bun run operator crew next` offers `publish_stack` or `settle_publish`, or shows `stack_open` or `stack_fault`, and when the user reports a merge or a close of a pull request.

The CLI publishes the integration branch of a source as one integrated pull request, behind one approval of the person (ADR 0022).
A person merges it on GitHub.
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
The reviewer wrote the title, the summary, where to start reading, and the merge danger in its report, and the CLI renders every other section of the body from the records.

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
- `section_missing`: the review that gates the publish recorded no published text.
- `body_too_long`: a body is over 65536 characters, the GitHub limit.
- `repository_unread`, `merge_commit_not_allowed`, `signatures_required`: the repository and the rules of its default branch. A rule that the plan cannot read is shown as unverified, never as a pass.
- `remote_missing`, `remote_ambiguous`, `remote_unread`: the one remote whose URL names the repository of the source.
- `remote_name_taken`: the remote already holds the new branch name.
- `base_not_on_target`: the integration base is not an ancestor of the fetched tip of the default branch.

The target branch is the default branch of the source repository.
The new remote branch is `operator/<source slug>/<publication>/1`.

## Approval

Ask the person to read the file and to approve the exact request the plan names:
action `publish`, the source as scope, the plan revision as request revision, and these targets:

- the new remote branch name and the target branch;
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
Then it records the publication and each write as an intent, pushes every new name in one atomic push with no force option, and opens the pull request, ready for review.
It answers `published` with the pull request.
Operator deletes no branch.

## Settle

A write whose outcome is not recorded shows as `settle_publish`.
Run the same apply again with the revision that the action names.
Each write reads GitHub first: names that are already at their commits push nothing, and a pull request whose head is the new name is found and not created again.
`publish_uncertain` means the answer was lost, so run it again.
`publish_conflict` and `publish_failed` wait on the person: a remote name at another commit, more than one pull request for one head, or a write GitHub refused.
Operator writes nothing over them.

## Merge and status

A person merges the pull request on GitHub with a merge commit.
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

## Stack faults

`publish status` answers `stack_fault`, and `crew next` offers `settle_publish` with the blocker `stack_fault`, when GitHub shows an outcome that no publication planned:

- `not_merge_commit`: a squash or rebase merge. The tracker steps of its items still run, and the resolution names the commit that landed and the method.
- `base_not_target`: a merge into a base that is not the target. It completes nothing.
- `head_moved`: the head is not the published commit, so it holds a commit that no review read.
- `closed_unmerged`: a close with no merge.

Operator adopts nothing from a fault.
Bring it to the user, and run the read again when the user reports it settled.

## Finished source

A source is finished when every pull request of its last publication merged with a merge commit and every tracker step of its items is verified.
The read or the tracker step that finishes it removes its gate checkout by an unforced Herdr removal, with no approval.
Herdr refuses a checkout that holds a change, so it stays, and the report says so.
Operator deletes no branch, and a person deletes the remote branches.
