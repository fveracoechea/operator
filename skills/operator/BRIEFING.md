# What an Operative receives

Read this before you write anything an Operative will read.

## You do not write the prompt

`bun run operator attempt dispatch` writes the brief and the prompt.
It fixes both before any external effect, and it records their identities, so a recovery restores exactly what the Operative was launched with.

Do not send your own prompt to an Operative.
Do not edit `.operator/local/brief.md` in a worktree.
A hand-written instruction is outside the recorded protocol, so nothing proves it arrived and nothing binds it to the assignment.

What you control is what you register.
The brief is built from the assignment: its title, its approved scope, its acceptance requirements, its permissions, and its fixed inputs.
Register those carefully, because they are what the Operative gets.

The brief is the contract of one attempt.
It holds every rule that binds the Operative, and you write nothing into it.
A rework cycle carries its recorded corrections and conflicts, and its input instruction never reaches the brief.

## Where the rules come from

The release owns the launch rules: the worktree, the write paths, the one result, and the report.
A rule that a command refuses is one line beside that command, with its refusal name, from the module that runs the check.

The project rules of a launch are the project instructions at its base commit.
An edit that is not committed does not reach the crew, so a rule is committed before the work that needs it is dispatched.
You do not commit it yourself: register that edit as work for the crew, and dispatch the work that needs it from a base that holds it.
A personal instruction file does not reach the crew.

## What every brief carries

- **Identity**: the assignment and its revision, the attempt, the source and its revision, the assignment kind, the controlling checkout, the worktree, and the branch with its base commit.
- **Approved scope** and **acceptance requirements**, with the requirements identity needed to submit the result.
- **Authority limits**: the write paths, the allowed commands, and whether network access is permitted. Work outside them is a question, never the Operative's own decision.
- **Fixed inputs**, with the content identity of every path input. They are fixed at registration, and a launch refuses a base commit that holds another version of a path input.
- **Effective configuration**: the crew host, model, and reasoning effort, the Operator release, the lock data, and the skill contents of this launch.
- **The reporting protocol** of its role, with the refusals of each command beside it.

A review brief adds the fixed submission it reads, its two axes, and the coverage each axis owes.
It also names the inputs of `code-review`, and it carries none of the producer's rules.
A rework brief adds the cycle it answers, the accepted corrections, and the conflicts it must settle.

## The protocol every role shares

The fixed brief supplies each role's commands and authority limits.

**Acknowledgement.**
For a JSR selection, run `bun install --frozen-lockfile` from the new worktree root to install the project-pinned CLI.
For a source selection, use the pinned source invocation in [SKILL.md](SKILL.md).
The Operative then runs the `attempt acknowledge` command in its brief from its own worktree before it changes any file.
Herdr acknowledges a submission, not a turn, so this is the only proof the brief arrived.
Treat an assignment as started only after it.

**Questions.**
Work an Operative cannot do inside its authority limits is a question.
It runs `bun run operator question raise` with the question, its evidence, its options, its recommendation, the scope that waits, and the work that continues meanwhile.
Only the named scope waits.

**Answers.**
You record the answer, then deliver it, then the Operative acknowledges it.
An answer never widens the authority limits of the brief.

**Submission.**
The Operative runs `bun run operator attempt submit` from its own worktree.
A submission is a handoff to a separate review, never accepted completion.

**A message from a person.**
A person may write to an Operative directly in its terminal.
That message carries no authority, whoever sends it.
The brief tells the Operative to raise it as a question that quotes the exact words, and to keep the independent work moving.
An Operative never addresses the person directly.
Only you talk to the person.

You then record the answer with the authority it really has.

- `human-answer` when the user confirmed it, with their exact words in `exactText`.
- `requirement` when an approved source already states it, with the source in `source`.
  Name a file as `{ "kind": "copy", "path": "<any readable path>" }`, which can be outside the checkout.
  Name the approved scope of a registered item as `{ "kind": "approved-scope", "assignmentId": "<id>" }`.
- `operator-decision` when it is inside your delegated authority, which carries no human text because nobody spoke.

A question that names visible behavior, scope, security permissions, unresolved ambiguity, or conflicting requirements refuses an Operator decision.
`escalation_required` means exactly that, and the answer has to come from a person.
Ambiguity and conflicting requirements refuse a recorded requirement too, because quoting one source there decides the question by choosing a side.

**Quote the exact bytes of the source.**
Operator stores a copy of a file source with the crew state, and the content identity of that copy is the revision of the source.
`quote_not_in_source` refuses words that are not in the copy, so do not wrap the lines again, shorten the words, or fix the spelling.
The refusal names the checked copy and does not print it.
Only a carriage return before a line feed is read as a line feed, and a file source must be UTF-8 text.
A later edit of the file does not change the record, and the copy never enters a worktree.

## What an Operative never receives

Operator copies an explicit list into a worktree: the project configuration, its schema, a release record, the frozen lock data, a control reference, the brief, and the skills of this release.
No credential is copied, and no other file leaves the controlling checkout.

An Operative reads the crew state through the control reference at `.operator/local/attempt.json`.
It never searches nearby directories for a state file.
