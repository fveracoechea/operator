---
"@fveracoechea/operator": minor
---

`operator question answer` checks the exact words of a `requirement` against a stored copy of its source.
The `source` of a requirement is now `{ "kind": "copy", "path": ... }` or `{ "kind": "approved-scope", "assignmentId": ... }`, and the old `{ "id", "revision" }` shape is refused.
A quote that is not in the source refuses with `quote_not_in_source`.
The crew state moves to version 3, so run `operator update` to migrate it.
