# Registering approved work

Read this before you register anything.
What you register is what every Operative receives, because the brief is built from it.

```sh
bun run operator work register --request <id> --owner-token <token> --input work.json --json
```

The input is a JSON file, or `-` to read standard input.

## The source

```json
{
  "sourceKind": "specification",
  "source": {
    "id": "github:fveracoechea/operator#15",
    "revision": "rev-1",
    "tracker": "github",
    "location": { "repository": "fveracoechea/operator", "mapIssue": 1 }
  },
  "items": []
}
```

`sourceKind` is `specification`, `ticket`, or `wayfinder`.
These are the three approved origins, and each one keeps its own revision.

`revision` names the exact version of the source you read.
A source is fixed at the revision it was registered with.
Registering it again at another revision is a conflict, because assignment inputs stay fixed once they exist.
`source_revision_changed` means exactly that, and it needs your decision, not a retry.

`location` says where the source lives in its tracker.
`mapIssue` is the wayfinder map an amendment is written to, or `null` when the source has none.
A source registered with no location records none, and its assignments refuse tracker updates rather than writing to a guessed ticket.

## The items

```json
{
  "key": "15.1",
  "title": "Build the dispatch path",
  "kind": "production",
  "trackerIssue": 24,
  "approvedScope": "Build the dispatch path and nothing else.",
  "acceptanceRequirements": ["The quality gate passes."],
  "permissions": {
    "writePaths": ["modules/operative-dispatch/", ".changeset/dispatch-path.md"],
    "allowedCommands": ["bun test"],
    "network": false
  },
  "fixedInputs": [
    { "name": "spec", "kind": "path", "value": "docs/spec.md", "contentIdentity": "<sha256>" }
  ],
  "dependsOn": [{ "key": "15.0" }]
}
```

`key` names the item inside its source.
Registering the same key twice names the existing assignment instead of creating a second one.

`kind` is `production`, `review`, or `planning`.
A wayfinder item states `wayfinderType` instead: `task` is production, and `research`, `grilling`, and `prototype` are planning.

`trackerIssue` binds this assignment to its ticket.
The binding is fixed at registration, so a later configuration change cannot redirect work that already exists.
An item registered without one records no ticket, and its tracker updates are refused.

`approvedScope` and `acceptanceRequirements` reach the Operative word for word.
Write the scope as the limit it is, not as a summary of the goal.
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
Registration reads the file, and `fixed_input_mismatch` means the checkout does not hold it or holds other bytes.
The Operative reads the file at the base commit of its launch, so the file must be committed before you dispatch.
A launch whose base commit holds other bytes, or no file, fails at `input_preparation` and starts no agent.
You do not edit or commit the file yourself: a change to it is crew work or the person's decision.
An item you register again with different fixed inputs is refused as `fixed_inputs_changed`, a conflict for you to settle.

`dependsOn` names the items this one waits for.
Name a key in the same source, or add `sourceId` to name an item in another one.
A dependency is released only by accepted completion, never by a submitted result.
A cycle is refused before anything is dispatched, and nothing is registered.
An item you register again with different dependencies is a conflict for you to settle.

## Write paths

A write path is a file, or a folder that ends with `/`, named from the repository root.
A folder covers everything under it, segment by segment, so `modules/crew/` does not cover `modules/crew-state/`.
The letter case counts, and there is no token for the whole repository.
A write path can name a file that does not exist yet.

Registration refuses a write path that is absolute, that has a backslash or a glob character, or that has an empty, `.`, or `..` segment.
It refuses a production item with no write path.
It reports every refusal at once, in item order, as `invalid_work_input`, and registers nothing.

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
A narrower path needs a new revision of the source, and that is the person's decision.

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
