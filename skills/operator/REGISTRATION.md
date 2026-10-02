# Registering approved work

Read this before you register anything.
What you register is what every Operative receives, because the brief is built from it.

Operator never creates an issue.
A person, or a planning skill such as `to-tickets`, creates the issues and links them.
The CLI reads the structure of the source from GitHub: the items, their order, their blocking links, and the text of each one.
Your input holds only what the tracker does not hold.

## Preview, then register

```sh
bun run operator work register --plan --input work.json --json
bun run operator work register --request <id> --owner-token <token> --input work.json --plan-revision <revision> --json
```

The input is a JSON file, or `-` to read standard input.

`--plan` reads the tracker and changes nothing.
It reports a summary: the counts of new, updated, unchanged, and withdrawn items, satisfied blockers, closed sub-issues, and refusals, the `planRevision`, and the `planPath`.
The full plan is the file at `planPath`: every item in item order, every withdrawal, every satisfied blocker, and every refusal in item order and then by blocker key.
Do not read the whole file yourself.
Give the path to the crew or the person who settles the refusals.

The registration names the `planRevision` that the preview reported.
It reads the tracker again, and it records only that plan.
`plan_revision_changed` means the tracker or the input changed after the preview.
Its blocker names each part that differs: the source, an item, or an input entry.
Preview again, and register the new revision.
The same tracker content and the same input always give the same revision and the same bytes.
The registration report gives only counts and the command `operator work frontier`, which lists each assignment.

## The input

```json
{
  "sourceKind": "specification",
  "source": "fveracoechea/operator#93",
  "items": [
    {
      "issue": "fveracoechea/operator#94",
      "kind": "production",
      "acceptanceRequirements": ["The quality gate passes."],
      "permissions": {
        "writePaths": ["modules/operative-dispatch/", ".changeset/dispatch-path.md"],
        "allowedCommands": ["bun test"],
        "network": false
      },
      "fixedInputs": [
        { "name": "spec", "kind": "path", "value": "docs/spec.md", "contentIdentity": "<sha256>" }
      ]
    }
  ]
}
```

`sourceKind` is `specification`, `ticket`, or `wayfinder`.
A specification and a wayfinder map are a parent issue with its sub-issues.
A ticket is one issue, and it is its own item.

`source` and each `issue` name an issue as `<owner>/<repo>#<number>`.
The key is lowercase, because GitHub names are case-insensitive.
The source id is the key of the parent issue, so one issue is only one source.

Name each open sub-issue once, and no other issue.
`input_issue_missing` names a sub-issue that the input leaves out, and `input_issue_outside_source` names an issue that is not an open sub-issue of the source.
A closed sub-issue is not registered.
The input has no title, scope, key, order, or dependency field, and an input with one is refused as `invalid_work_input`.

`kind` is `production` or `planning` for a specification or ticket item.
A wayfinder item takes its kind from its `wayfinder:<type>` label: `task` is production, and `research`, `grilling`, and `prototype` are planning.
You can leave `kind` out of a wayfinder item.
A stated kind that contradicts the label is refused as `item_kind_contradicted`, and an item with no single known label as `wayfinder_type_unreadable`.

`acceptanceRequirements` reach the Operative word for word.
Write each requirement as something a reviewer can check.

`permissions` are the authority limits in the brief.
Name the paths the Operative may write, the commands it may run, and whether it may reach the network.
Work outside them is a question to you, never the Operative's own decision, so a limit that is too narrow costs a question and a limit that is too wide costs control.

`fixedInputs` are fixed at registration, so a later change to their source does not change the work.
A fixed input is an artifact of one item, such as a design note that this item needs.
It is not a shared rule block: a rule for every item is a check, or a line in the committed project instructions.
The reviewer reads the fixed inputs as part of the spec, so a rule registered there is reviewed as a requirement of the work.
A `value` input carries its text.
A `path` input carries its path and its content identity, because a large artifact stays outside the crew state.
The path names a file inside the checkout, relative to its root, with no empty, `.`, or `..` part, because the launch reads that exact spelling from Git.
A path input with no content identity, or one outside the checkout, is refused as `invalid_work_input`.
Registration reads the file, and `fixed_input_mismatch` means the checkout does not hold it, holds other bytes, or holds a link that leads out of the checkout.
The Operative reads the file at the base commit of its launch, so the file must be committed before you dispatch.
A launch whose base commit holds other bytes, or no file, fails at `input_preparation` and starts no agent.
You do not edit or commit the file yourself: a change to it is crew work or the person's decision.

## What the tracker gives

The title and body of each issue are its approved scope, exactly as read.
Each assignment records the content identity of its own title and body, and the source revision is the content identity of the parent title and body.
A carriage return before a line feed is removed before an identity is taken, and the issue state and the comments are outside both.

The item order is the stored sub-issue order, and it only breaks ties in the frontier.
A blocking link is a dependency:

- A blocker that is an open sub-issue of the same source is a dependency inside it.
- A closed blocker is satisfied, and the plan names it.
- A blocker that is an item of another registered source is a dependency on that assignment.
- `blocker_in_other_source` refuses a production item whose blocker is an open production item of another source, because that commit lands only on the integration branch of its own source. Put both items under one parent, or register this item after the other source merges.
- `blocker_unregistered` refuses an open blocker that no registered source holds.
- `dependency_cycle` refuses blocking links that form a cycle.

A dependency is released only by accepted completion, never by a submitted result.

The CLI also refuses:

- `executable_item_in_other_repository`: a production item in another repository, because its commit cannot land on the integration branch of the source. A planning item there is allowed.
- `source_without_items`: a specification or wayfinder parent with no open sub-issue. Ask the person to link them.
- `tracker_read_incomplete`: a read that did not cover every sub-issue or every blocker set. An incomplete read is a gap, not a proof that nothing is there.
- `source_not_found`: a source issue that GitHub does not hold.
- `source_already_registered`: a source key that the crew state holds for another parent issue.
- `issue_already_registered`: an issue that another source already holds.
- `source_recorded_without_parent`: a source that an earlier release registered from a hand-written structure. Finish its work, or register its parent issue as a new source.

Every refusal is a decision for the person or the crew, never a reason to change the issues yourself.

## A new read of a registered source

After the first registration, a person can add sub-issues or change an issue.
Only a new `work register` of the same source reads the tracker again, with the same preview and registration commands.
`crew next` never reads the tracker.

The new read matches each recorded item by its issue database id, so a renamed repository does not make a second item, and the source keeps its id.
The preview names each item as `new`, `updated`, or `unchanged` in the plan file, and the report gives the three counts.
Name only the new items and the changed items in the input.
An entry that repeats the recorded fields of an item changes nothing.

- A new open sub-issue is added at its stored position, with no approval.
- A changed parent title or body is a new source revision. Each recorded assignment keeps the revision it was registered under, and the new and updated items take the new one.
- A changed item that has no attempt and is not accepted takes its new content: its text, its kind, its blocking links, or its input entry. Its dependencies are checked for a cycle again, and `dependency_cycle` refuses a new cycle. Its input entry is required, so `input_issue_missing` names a changed item that the input leaves out.
- `recorded_item_changed` names a changed item that has an attempt or is accepted. The writer read the old text, so the person puts the change in a new sub-issue.
- `recorded_item_closed` names a recorded item that the read finds closed while it is not accepted. Its hint tells the person to remove it from its parent to withdraw it, or to reopen it.
- A recorded item that the read does not find is a withdrawal, as the next section shows.
- `source_kind_changed` refuses an input that states another source kind than the one recorded.

A new source revision, an updated item, or a withdrawal needs the person's approval of this exact plan revision.
The preview then reports `approval`: the exact `registration-change` approval, which names the source and the plan revision.
Tell the person the counts and the `planPath`, and give the file to the crew or the person who checks the changes.
Do not decide the change yourself, because a change of approved scope is the person's decision.
When the person approves, record their exact words as that approval, and then register the plan revision:

```sh
bun run operator approval grant --request <id> --owner-token <token> --input approval.json --json
```

The input is the reported `approval` with `exactText`, the words of the person, and `"grantedBy": "human"`.
A registration with no approval of that plan revision is refused as `approval_required`, and nothing is recorded.
A new preview gives a new revision, so an approval of an earlier revision covers nothing.

## Withdraw an item

Only a person withdraws an item, because scope is outside delegated authority.
The person removes its sub-issue from the parent on GitHub, and the next `work register` of the source records the withdrawal.
There is no withdrawal command, and you never remove a sub-issue yourself.
A closed issue is not a withdrawal, because Operator also closes the issues it completes.

Tell the person to wait until no attempt of the item runs.
The plan refuses, and names what it waits for:

- `withdrawal_attempt_active` names an active attempt of the item, or of a review of its result. The attempt runs to its handoff, and nothing stops it.
- `withdrawal_effect_unsettled` names a tracker step of the item that has no recorded outcome. Recover the step first.
- `withdrawal_dependent_pending` names each recorded dependent, in any source, that still names the item as a blocker. The person removes that dependent from its parent in the same read, or drops the blocking link. Dropping the link is a changed item, so a dependent that has an attempt is refused as `recorded_item_changed`, and it is withdrawn with the item. Settle a dependent in another source with a registration of its own source first.

The plan file lists each withdrawal under `withdrawals`, with its recorded state and its recorded `landing`, the commit that carries its accepted code result.
The preview reports the `registration-change` approval of the plan revision, as for any other change, and a withdrawal is recorded only under it.
Give the counts and the `planPath` to the person, and record their exact words as the approval.

A withdrawn assignment is terminal.
It never satisfies a dependency, the frontier lists it under `withdrawn`, and a claim of it is refused as `assignment_withdrawn`.
Its attempts, submissions, reviews, findings, and planning record stay as history.
Its open cycle, its open invalidation, its open direction request, and each review of it that no attempt holds close in the same change.
Operator writes nothing to the tracker for a withdrawal, because the removal that the person made is already there.
A withdrawn item with no landed commit releases its write paths.

- `withdrawn_item_readded` refuses a withdrawn issue that a person adds to its parent again. A new sub-issue carries the work.
- `blocker_withdrawn` refuses an item that names a withdrawn item as a new blocker, because that dependency would wait for ever.

A checkout of withdrawn work that holds its commit holds unlanded work.
`crew next` offers no removal of it, `bun run operator cleanup show` lists it under `unlanded`, and `cleanup remove` refuses it as `unlanded_work`.
Only the person removes that checkout.

## Write paths

A write path is a file, or a folder that ends with `/`, named from the repository root.
A folder covers everything under it, segment by segment, so `modules/crew/` does not cover `modules/crew-state/`.
The letter case counts, and there is no token for the whole repository.
A write path can name a file that does not exist yet.

Registration refuses a write path that is absolute, that has a backslash or a glob character, or that has an empty, `.`, or `..` segment.
It reports every write path refusal at once, in item order, as `invalid_work_input`, and registers nothing.
A production item with no write path is a plan refusal, `write_paths_required`.

Work that an earlier release registered can hold a write path with no grammar.
The CLI reads such a path in its canonical form: it removes each empty and `.` segment, and `..` removes the segment before it.
A path with no final `/` stays a file.
When a stored path has no canonical form, because it is absolute, has a backslash or a glob character, or leaves the repository root, each command that reads it fails and names the path.
Tell the person the path and the assignment. Do not edit the crew state.

Name the narrowest paths that hold the work.
Under ADR 0004, the crew frontier never offers new work whose write paths overlap the paths that unaccepted work of the same source holds, so broad paths make a source run one assignment at a time.
[COORDINATION.md](COORDINATION.md) names the blocker that this hold reports.
For a shared folder, name the exact file, for example the item's own `.changeset/<name>.md`, not `.changeset/`.

The registration report gives only a summary of the overlaps: in `overlaps`, the number of pairs of production items whose write paths overlap and that no dependency orders, the item keys involved, and the command that lists each pair.
This is information, not a refusal, and the items stay registered.
Do not list the pairs yourself.
Tell the person the number of pairs and the command.
A narrower path for a registered item is the person's decision.

## Planning work is registered too

Planning work is registered so dependencies resolve, and it is never dispatched to an Operative.
It reaches acceptance with no attempt, and its acceptance records a planning record.
`work accept` refuses planning work with no record as `planning_record_required`, and it refuses planning work whose own dependencies are not accepted as `dependency_pending`.

`bun run operator crew next` offers it as `resolve_planning` once its own dependencies are accepted.
That action carries `planningRecords`: a pointer to the record of each planning item it depends on directly.
Without it, a task blocked by a research item could never start, because the research item could never be claimed.

You do not resolve planning work yourself.
Give the reading, the research, and the draft of the record to a sub-agent of the crew, and give it the `resolve_planning` action.
That action names each planning record it depends on by id, identity, and entry count, and the command that prints it in full: `bun run operator work record --assignment <id>`.
Do not run that command yourself. The sub-agent reads the records, writes the record file and each artifact, and reports where they are.
Preparing the record is not a dispatch, and the sub-agent holds no assignment.
The sub-agent never talks to the user: when a decision needs the user, it gives you the question, and you bring it to the user and give the answer back word for word.
Read only its short report, then accept with the record:

```sh
bun run operator work accept --request <id> --owner-token <token> --assignment <id> --revision <n> --input record.json --json
```

```json
{
  "entries": [
    {
      "question": "Do we keep the old export path?",
      "escalationTriggers": ["scope"],
      "authority": "human-answer",
      "exactText": "No, remove it.",
      "interpretation": {
        "summary": "The old export path is removed.",
        "directives": ["Delete the old export path and its tests."],
        "appliesTo": ["The export work of this source."]
      }
    }
  ],
  "artifacts": [
    { "name": "rejected-options", "path": "/tmp/plan/rejected.md", "contentIdentity": "<sha256>" }
  ]
}
```

Each entry is one decision, in order.
`question` is the question as it was asked, and `escalationTriggers` are the subjects it names.
`authority` is the answer authority of the decision, in the shape of a question answer:

- `human-answer` quotes the user in `exactText`.
- `requirement` quotes an approved source in `exactText` and names it in `source`: `{ "kind": "copy", "path": "<file>" }` for a file from any path, `{ "kind": "approved-scope", "assignmentId": "<id>" }`, or `{ "kind": "source-revision", "sourceId": "<id>", "revision": "<revision>" }` for the recorded revision of a work source.
  The words must be an exact substring of the source, or the record is refused as `quote_not_in_source` with the entry number.
  A requirement cannot settle `ambiguity` or `conflicting-requirements`, so such a decision goes to the user.
- `operator-decision` quotes nobody. Only a `research` item may record one.
  A `grilling`, a `prototype`, and the planning item of a specification or a ticket refuse it as `operator_decision_not_allowed`.

A general delegation such as "decide from my opinions" is not a human answer.
It makes the named file an approved source, so each decision quotes it as a requirement.

`interpretation.appliesTo` describes the scope a decision covers.
Never list the assignments that receive it: the dependency edges decide that.
A planning item that turns out not to be needed records one entry that says so.

An artifact is a longer text, such as a resolution document or a proposed ADR text.
This is where the prose of a decision goes, such as the rejected options and the consequences for other work.
The sub-agent writes it outside the project, because you never change the project yourself.
State the content identity of each file; Operator stores a copy under `.operator/local/planning/` and refuses a file that does not match as `artifact_identity_changed`.

The record is fixed once it is accepted.
A changed decision is an invalidation of the planning work, as [INVALIDATION.md](INVALIDATION.md) shows.

The tracker resolution of planning work is rendered from its record: each entry in order, then the content of each text artifact.
Send the resolution step with no body.
A body is refused as `planning_body_not_allowed`, and a rendered body over the GitHub comment limit is refused as `comment_too_long` with its size, before anything is written.

## After registration

Read [COORDINATION.md](COORDINATION.md).
`bun run operator crew next` offers the work the frontier allows, in the order it allows it.
