# Registering approved work

Read this before you register anything.
What you register is what every Operative receives, because the brief is built from it.

```sh
operator work register --request <id> --owner-token <token> --input work.json --json
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
    "writePaths": ["modules/"],
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

`fixedInputs` are pinned at dispatch, so a later change to their source does not change the work in progress.
A `value` input carries its text.
A `path` input carries its path and its content identity, because a large artifact stays outside the crew state.
A path input with no content identity is refused.

`dependsOn` names the items this one waits for.
Name a key in the same source, or add `sourceId` to name an item in another one.
A dependency is released only by accepted completion, never by a submitted result.
A cycle is refused before anything is dispatched, and nothing is registered.
An item you register again with different dependencies is a conflict for you to settle.

## Planning work is registered too

Planning work is registered so dependencies resolve, and it is never dispatched to an Operative.
You resolve it yourself and accept it with no attempt.

```sh
operator work accept --request <id> --owner-token <token> --assignment <id> --revision <n> --json
```

`operator crew next` offers this as `resolve_planning` once its own dependencies are accepted.
Without it, a task blocked by a research item could never start, because the research item could never be claimed.

## After registration

Read [COORDINATION.md](COORDINATION.md).
`operator crew next` offers the work the frontier allows, in the order it allows it.
