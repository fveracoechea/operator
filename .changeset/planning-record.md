---
"@fveracoechea/operator": minor
---

`operator work accept` of planning work now records a planning record, named with `--input`.
An acceptance with no record refuses with `planning_record_required`, also for invalidated planning work, and planning work whose own dependencies are not accepted refuses with `dependency_pending`.
Each entry is a `human-answer`, a `requirement` whose quote is checked against its source, or an `operator-decision`, which only a `research` item may record.
A requirement can quote the recorded revision of a work source with `{ "kind": "source-revision", "sourceId": "<id>", "revision": "<revision>" }`, and a revision that is no longer recorded refuses with `source_revision_changed`.
The `resolve_planning` action of `operator crew next` names the record of each direct planning dependency by id, identity, and entry count, and the new read-only `operator work record --assignment <id> [--record <id>]` prints a record in full.
`operator tracker record` renders the resolution of planning work from its record and refuses a free body with `planning_body_not_allowed`.
A comment over the GitHub limit refuses with `comment_too_long` before the write.
A refused requirement quote no longer stores a copy of its source.
The crew state moves to version 7, so run `operator update` to migrate it.
