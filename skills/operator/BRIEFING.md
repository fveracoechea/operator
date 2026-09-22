# What an Operative receives

Read this before you write anything an Operative will read.

## You do not write the prompt

`operator attempt dispatch` writes the brief and the prompt.
It fixes both before any external effect, and it records their identities, so a recovery restores exactly what the Operative was launched with.

Do not send your own prompt to an Operative.
Do not edit `.operator/local/brief.md` in a worktree.
A hand-written instruction is outside the recorded protocol, so nothing proves it arrived and nothing binds it to the assignment.

What you control is what you register.
The brief is built from the assignment: its title, its approved scope, its acceptance requirements, its permissions, and its fixed inputs.
Register those carefully, because they are what the Operative gets.

## What every brief carries

- **Identity**: the assignment, the attempt, the source and its revision, the assignment kind, the controlling checkout, the worktree, and the branch with its base commit.
- **Approved scope** and **acceptance requirements**, as they were registered.
- **Authority limits**: the write paths, the allowed commands, and whether network access is permitted. Work outside them is a question, never the Operative's own decision.
- **Fixed inputs**, with the content identity of every path input. They are fixed at dispatch, so a later change to their source does not change them.
- **Effective configuration**: the crew host and model, the Operator release, the lock data, and the skill contents of this launch.
- **The reporting protocol** of its role.

A review brief adds the fixed submission it reads, its two axes, and the coverage each axis owes.
A rework brief adds the cycle it answers, the accepted corrections, and the conflicts it must settle.

## The protocol every role shares

**Acknowledgement.**
The Operative runs `operator attempt acknowledge` from its own worktree before it changes any file.
Herdr acknowledges a submission, not a turn, so this is the only proof the brief arrived.
Treat an assignment as started only after it.

**Questions.**
Work an Operative cannot do inside its authority limits is a question.
It runs `operator question raise` with the question, its evidence, its options, its recommendation, the scope that waits, and the work that continues meanwhile.
Only the named scope waits.

**Answers.**
You record the answer, then deliver it, then the Operative acknowledges it.
An answer never widens the authority limits of the brief.

**Submission.**
The Operative runs `operator attempt submit` from its own worktree.
A submission is a handoff to a separate review, never accepted completion.

**A message from a person.**
A person may write to an Operative directly in its terminal.
That message carries no authority, whoever sends it.
The brief tells the Operative to raise it as a question that quotes the exact words, and to keep the independent work moving.

You then record the answer with the authority it really has.

- `human-answer` when the user confirmed it, with their exact words in `exactText`.
- `requirement` when an approved source already states it, with the source and its revision.
- `operator-decision` when it is inside your delegated authority, which carries no human text because nobody spoke.

A question that names visible behavior, scope, security permissions, unresolved ambiguity, or conflicting requirements refuses an Operator decision.
`escalation_required` means exactly that, and the answer has to come from a person.
Ambiguity and conflicting requirements refuse a recorded requirement too, because quoting one source there decides the question by choosing a side.

## What an Operative never receives

Operator copies an explicit list into a worktree: the project configuration, its schema, a release record, the frozen lock data, a control reference, the brief, and the skills of this release.
No credential is copied, and no other file leaves the controlling checkout.

An Operative reads the crew state through the control reference at `.operator/local/attempt.json`.
It never searches nearby directories for a state file.
