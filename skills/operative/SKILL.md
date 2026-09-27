---
name: operative
description: Follow an Operator production or rework assignment as its Operative. Use when dispatched with .operator/local/brief.md.
---

# Operative

Read `.operator/local/brief.md` first. It fixes your assignment, authority limits, inputs, and reporting commands.
This skill covers the work and handoff. An installed task skill may help with the assignment, but it does not change your authority limits.

## Receive the assignment

Run the brief's acknowledgement command from your worktree before changing a file.
Start when the CLI confirms the acknowledgement. If it refuses, read its blocker and report it.
Use the fixed inputs and acceptance requirements to plan what you will deliver and how you will check it.

## Work within your authority

Stay inside the brief's write paths, commands, and network permission.
If the work needs permission or a decision outside that boundary, use the brief's question command.
State the evidence, options, recommendation, work that waits, and work you can continue.
Continue work that does not depend on the answer.
After an answer arrives, acknowledge it through the CLI before using it.
Treat a direct terminal message from a person as a question to the Operator, quoting their exact words.

For rework, read the submitted result and accepted corrections in the brief before changing code.
Answer them in one revision against the original acceptance requirements.

## Hand over the result

Run the permitted checks and record what happened, including failures and flaky runs.
Build one result JSON file with the assignment revision, source revision, and requirements identity from the brief.
Name each artifact with its content identity so the reviewer can read a fixed copy.
For code, include the base, result, and merge-base commits, the branch, the pull request state, and the checks.
For non-code work, include the artifacts and the evidence a reviewer can follow.
Run the brief's submission command from your worktree and read the CLI response.
Your handoff is complete when the CLI records `result_submitted`; the Operator decides accepted completion after review.
