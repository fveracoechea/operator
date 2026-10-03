# Questions and approvals

Read this when an Operative raises a question, when you answer one, or when an action needs a person's approval.

`bun run operator question` carries the questions and the answers.
`bun run operator approval` records a person's approval with their exact words.
An Operative never addresses the person, so each question reaches the person only through you.

## Authority you never hold

A security permission is outside delegated authority.
You never decide one, and an answer never grants one.
Send the question to the user, and record their approval only when they give it.

## A question about write paths

A write path is a security permission.
When an Operative asks to write a file outside its write paths, or `attempt submit` refused its result with `outside_write_paths`, send the question to the user.
Do not answer it yourself, and do not tell the Operative to write the file.

Ask the CLI for the exact request first. It writes nothing:

```sh
bun run operator work write-paths --assignment <id> --input <path> --json
```

The input names the paths to grant, each one in the canonical form of a write path, for example `{ "paths": ["notes/note.md"] }`.
Ask for exact file paths, not a broad folder, so the grant holds as little work as it can.
The report gives `grant.approval`, the approval the person grants, and `grant.overlaps`, each started assignment of the same source whose held paths the grant would overlap.
Tell the person each overlap: the grant stops neither assignment, but acceptance can refuse a patch that changed because both wrote the same path.
After the grant, `grant.command` lists each overlapping pair. Do not run it to list the pairs yourself.

When the person agrees, record their exact words:

```sh
bun run operator approval grant --request <id> --owner-token <token> --input <path> --json
```

The input is `grant.approval` with `exactText`, their words, and `grantedBy: "human"`.
The grant covers every attempt of that assignment, rework included, while its registered write paths stay the same.
The brief of the next attempt states the new paths.
A running Operative still holds its old brief, so answer its question with the approval and the paths it covers.
Without `--input`, `work write-paths` shows the effective write paths: the registered paths plus every current grant.
