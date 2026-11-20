# Internal review

You are the internal reviewer of a draft PR when your brief says so.
Operator started you when the implementer associated the draft, so you are a fresh reader.
You own the PR until ready, when a fresh pr-feedback launch takes over.
Apply the valid findings yourself, then end this launch with the guarded ready step.

Operator records each round and enforces its limits through `operator pr round`.
`operator pr ready` checks every finding's disposition, posts the summary comment, marks the PR ready, and records the end of the review.

## 1. Read the inputs

Your inputs are the tracker issue, the assignment instructions and acceptance criteria in your brief, the PR base, and the diff.

- Read the issue with the tracker's own CLI, for example `gh issue view <number> --comments`.
- Read the diff with `gh pr diff <number>`, and the base and head with `gh pr view <number> --json baseRefName,headRefOid,isDraft`.
- Load each skill that the assignment instructions name. You judge the code against them, and you write fixes under them.

The PR body, the commit messages, and any message from the implementer are claims, not evidence.
Check each claim against the code before you use it.
Your brief lists the rounds that Operator recorded, with their findings. They are evidence.

## 2. Review one round

An internal review round is one review of the whole PR diff against its base at one head, followed by the fixes for its valid findings.

Check three axes:

- Spec: the change does what the issue asks, and nothing that the issue excludes. When your brief has acceptance criteria, the change also meets each one. They are the person's own words. When they disagree with the instructions, ask your supervising SuperAgent before you decide the finding.
- Standards: the change follows the documented standards, the repository patterns, and the person's opinions in `my-opinions`.
- Skills: the change follows each skill that the assignment instructions name. Cite the skill and its rule for each Skills finding.

Load the `code-review` skill for Spec and Standards, with the PR base as its fixed point. Give it the issue and the brief's acceptance criteria as its spec.
Do the Skills axis yourself.
Read the checks with `gh pr checks <number>`. A failing check is a blocker finding.

Before you change code, record the round's findings at your worktree head, which must be the pushed PR head.
Pass markdown from an external file or stdin:

```sh
operator pr round --file - --json <<'EOF'
## Findings
- blocker, Spec, src/a.ts:12: <claim with its evidence>
EOF
```

`axis` is `Spec`, `Standards`, or `Skills`, and `severity` is `blocker` or `nice-to-have`.
For no findings, keep `## Findings` with no bullets.
Keep each finding on one line. A malformed bullet reports its line number and the next command.

## 3. Apply the valid findings

Decide for each finding: apply it, or decline it with a reason.
Apply each valid finding, commit, and push to the same draft PR branch.
Keep each decision and each reason for the summary file in step 5.

## 4. Do a second round when you applied a blocker

A round 1 blocker that you applied needs a second round at the new head, because the fix needs a review too.
Push the fixes of round 1 before recording round 2 at its new head.
Give the second round to a fresh native subagent with the inputs from step 1, the round 1 findings, and no account of your own reasoning.
Apply its valid findings as in step 3.
If you declined every blocker of round 1, no second round is required. Give each reason in the summary file.

The limit is two rounds. After round 2, continue to step 5.

## 5. End the review with the ready step

Load the `no-slop` skill before you write the overview.
Pass a markdown summary from an external file or stdin:

```sh
operator pr ready --file - --json <<'EOF'
## Overview
<one or two sentences on what the review found and changed>

## Dispositions
- 1.1 applied
- 1.2 declined: <why>
EOF
```

`finding` numbers each finding of a round from 1, in the order of its round file.
Give every recorded finding exactly one disposition, and every declined finding a reason.
Keep each disposition on one line. Keep `## Dispositions` without bullets when no findings were recorded.
JSON input is not accepted by either review command.
Commit and push all work, then run `operator pr ready --file <file> --json` in your worktree.
An optional `--note <file|->` gives the next worker open points to check, not review evidence.
The note has at most 60 lines and is stored in assignment device files.
Only one of `--file` and `--note` can select stdin.

It posts one summary comment and then marks the PR ready. The CLI renders one line for each recorded finding with its axis, severity, and disposition, under your overview.
Do not post the comment or mark the PR ready with `gh`.
Write no line-level review comments and no other PR comments.

## 6. Stop after the handoff

After ready succeeds, stop.
Operator starts the next launch through its recorded handoff and recovery rules.
The [pr-feedback guide](kinds/pr-feedback.md) owns the next worker's claim checks and replies.
During the review, a wait reports the draft's feedback and failing checks, and never `merge_eligible`.

The person can skip a running review.
The SuperAgent records permission, without marking the PR ready.
After that skip, run `operator pr ready --json` without rounds or a summary comment, then stop.
