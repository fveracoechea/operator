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

Name the narrowest paths that hold the work.
Under ADR 0004, the crew frontier never offers an assignment whose write paths overlap the paths that unaccepted work of the same source holds, so broad paths make a source run one assignment at a time.
A later release adds this hold to the frontier, so name narrow paths now.
For a shared folder, name the exact file, for example the item's own `.changeset/<name>.md`, not `.changeset/`.

The registration report gives only a summary of the overlaps: in `overlaps`, the number of pairs of production items whose write paths overlap and that no dependency orders, the item keys involved, and the command that lists each pair.
This is information, not a refusal, and the items stay registered.
Do not list the pairs yourself.
Tell the person the number of pairs and the command.
A narrower path needs a new revision of the source, and that is the person's decision.

## Planning work is registered too

Planning work is registered so dependencies resolve, and it is never dispatched to an Operative.
You resolve it yourself and accept it with no attempt.

```sh
bun run operator work accept --request <id> --owner-token <token> --assignment <id> --revision <n> --json
```

`bun run operator crew next` offers this as `resolve_planning` once its own dependencies are accepted.
Without it, a task blocked by a research item could never start, because the research item could never be claimed.

## After registration

Read [COORDINATION.md](COORDINATION.md).
`bun run operator crew next` offers the work the frontier allows, in the order it allows it.
