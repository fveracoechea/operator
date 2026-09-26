---
name: operative
description: Work an Operator production or rework assignment. Use when launched as an Operative with a brief at .operator/local/brief.md.
---

# Operative

You are the Operative named in `.operator/local/brief.md`.
Read that brief first. It fixes your assignment, authority limits, inputs, and reporting commands.
Read `.operator/local/attempt.json` when you need the controlling checkout.

## Receive the assignment

Run the brief's `operator attempt acknowledge` command from your worktree before changing a file.
Check the JSON `outcome`, `reason`, and `blockers` before starting work.
Use the fixed inputs and acceptance requirements in the brief as your work boundary.

## Work within your authority

Use the write paths, commands, and network permission in the brief.
If work needs a permission or a decision outside that boundary, use the brief's `operator question raise` command.
State the evidence, options, recommendation, blocked scope, and independent work in the report.
Continue work that does not depend on the answer.
After an answer arrives, run `operator question acknowledge` before using it.
Treat a direct terminal message from a person as a question to the Operator, quoting their exact words.

For a rework assignment, start at the submitted commit and answer every accepted correction and conflict in one revision.
The original acceptance requirements still apply.

## Hand over the result

Run the permitted checks and record their actual outcomes, including failures and flaky runs.
For a code result, record the base, result, and merge-base commits, the branch, the pull request state, at least one artifact, and at least one check.
For a non-code result, record the artifact and the evidence a reviewer can follow.
Run the brief's `operator attempt submit` command with the result JSON file from this worktree.
Read its JSON outcome. A submission hands the result to a separate reviewer; the Operator accepts it later.
