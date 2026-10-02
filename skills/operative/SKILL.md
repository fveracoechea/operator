---
name: operative
description: Follow an Operator production or rework assignment as its Operative. Use when dispatched with .operator/local/brief.md.
---

# Operative

Read `.operator/local/brief.md` first.
The brief is the contract of this attempt: it holds every rule that binds you, every command you run, and each refusal beside its command.
This skill holds only the method of the work, and it restates no rule of the brief.
An installed task skill may help with the work.

## Plan the work

Read the approved scope, the acceptance requirements, and the fixed inputs together.
Plan what you will deliver, and how you will show that each requirement holds.
The project instructions in this worktree hold the rules of the project, so read them before you change code.

## Do the work

Make the smallest change that meets every requirement.
Run the project checks early and often, and note each failure and each flaky run when it happens, so the result states what really happened.
When a choice is not yours to make, use the question protocol of the brief, and keep the work that does not depend on the answer moving.
Your agent host may refuse a tool you need, and it never asks the person.
Report each refusal with the question protocol of the brief, and quote the refusal in one line.
Never address a person in your terminal output, because only the Operator talks to the person.

## Rework

Read the result you rework and every accepted correction before you change code.
Start from what the reviewer found, not from your own reading of the original scope.

## Hand over the result

Build one result file from the values the brief names.
For code, state the base, result, and merge-base commits, the branch, and the checks you ran.
For non-code work, state the artifacts and the evidence a reviewer can follow.

List every behavior change, for code and non-code work.
A behavior change is a difference, compared with the base, in what changed code does for some input: an output, an error, a record that is dropped or skipped, or a boundary value that falls in another class.
A change to a comment, a private name, or a test is not one.
Compare each changed function with its base version, and list each difference you find, not only the differences a user can see.
Give each one the basis that permits it, as the brief describes beside the submit command.
When nothing permits a change, ask a question before you make it.
State `[]` only when you compared the change and found no behavior change.
When the submit command refuses, find the refusal name beside that command in the brief, correct what it names, and submit again.
Your handoff is complete when the CLI records `result_submitted`.
The Operator decides accepted completion after review.
