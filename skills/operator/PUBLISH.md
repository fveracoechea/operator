# Publish

Read this when `bun run operator crew next` offers `publish_stack` or `settle_publish`.

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
action `publish`, the new remote branch name and the target branch as targets, the source as scope, and the plan revision as request revision.
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
