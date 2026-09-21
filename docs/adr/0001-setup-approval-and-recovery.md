# Setup approval by plan identity, with a write-ahead recovery journal

`operator setup` must show its exact changes and write nothing until the unchanged plan is approved, but Operator CLI commands are non-interactive.
So `setup plan` returns a `planId`, the SHA-256 of the selected targets plus the path, kind, observed content, and proposed content of every change, and `setup apply` recomputes the plan and refuses any approval that does not match.
The identity is derived from the observed project, so a changed project or a changed target invalidates the old approval without any stored session state.

## Considered options

A stored approval record inside `.operator/` was rejected.
It makes the approval a second source of truth that can disagree with the files on disk, and it needs its own staleness rules.
A confirmation prompt was rejected because the CLI holds no human conversation.

## Consequences

Before each write, setup appends the previous contents and the hash of the intended contents to `.operator/local/setup-journal.json`, then performs the write.
Rollback restores a file only when it still holds exactly what setup wrote, or when the recorded write never landed.
Any other content is a later user edit, so it is preserved and reported as a conflict.

`setup apply` refuses to start while an in-progress journal exists, because a fresh journal would discard the previous contents that rollback needs.
The caller must run `setup rollback` first.
