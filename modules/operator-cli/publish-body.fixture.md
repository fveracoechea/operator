## Summary

Adds the reviewed result and its notes.

## Commits

Review this pull request one commit at a time.

- [result](https://github.com/fveracoechea/operator/commit/<commit>) Closes fveracoechea/operator#1501.
- [result](https://github.com/fveracoechea/operator/commit/<commit>) Closes fveracoechea/operator#1502.

## Start here

Read docs/result.md first, because the notes refer to it.

## Behavior changes

- <short> result:
  - The result page now names the notes it reads. (basis: acceptance requirement 1, "The quality gate passes.")

## Verified

- Project gate: `true`.
- Gate run <id> passed at the base <short>.
- Gate run <id> passed at <short>.
- Gate run <id> passed at <short>.
- Result review <id> of commit <short> by claude-code.
- Result review <id> of commit <short> by claude-code.
- Branch review <id> of the head <short> by claude-code.

## Looks wrong and is not

- The order relation between two commits is wrong. (<short>) Rejected: The notes never read the result before it lands. Evidence: notes/notes.md names no path of docs/result.md.

## Not in this pull request

- The naming relation between two commits is wrong. Deferred: A rename touches every reader of the notes. Follow-up: fveracoechea/operator#200

## Concerns

- <short>: The reviewer decides whether the coverage rule is too strict.
- <short>: The reviewer decides whether the coverage rule is too strict.

## Merge danger

Nothing known: the change adds two new files.

## How to merge

Merge with a merge commit.
