# Internal review

You are the internal reviewer of a draft PR when your brief says so.
Operator started you when the implementer associated the draft, so you are a fresh reader. You also own the PR from now until its merge.
You apply the valid findings yourself, end the review with the ready step, and then run the PR feedback loop and the guarded merge.

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
The command refuses a file with any other shape, a third round, a second round at the head of the first, and a round after the review ended. A refusal records nothing.

## 3. Apply the valid findings

Decide for each finding: apply it, or decline it with a reason.
Apply each valid finding, commit, and push to the same draft PR branch.
Keep each decision and each reason for the summary file in step 5.

## 4. Do a second round when you applied a blocker

A round 1 blocker that you applied needs a second round at the new head, because the fix needs a review too.
`operator pr ready` refuses with `internal_review_second_round_required` until that round exists.
Push the fixes of round 1 first. `operator pr round` refuses round 2 at the head of round 1.
Give the second round to a fresh native subagent with the inputs from step 1, the round 1 findings, and no account of your own reasoning.
Apply its valid findings as in step 3.
If you declined every blocker of round 1, no second round is required. Give each reason in the summary file.

The limit is two rounds, and `operator pr round` refuses a third. After round 2, continue to step 5.

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

It posts one summary comment and then marks the PR ready. The CLI renders one line for each recorded finding with its axis, severity, and disposition, under your overview.
It refuses, and changes nothing, for a summary that leaves out or repeats a finding, for a round 1 blocker that you applied without a round 2, and for a worktree that is unclean or not at the PR head. Fix the cause and run it again.
After `github_uncertain`, run it again. It finds its earlier comment and posts no second one. If you pushed or recorded a round since, it updates that comment.
Do not post the comment or mark the PR ready with `gh`.
Write no line-level review comments and no other PR comments.

## 6. Own the PR to its merge

After the ready step, follow [pull-requests.md](pull-requests.md) from step 3 on: run `operator pr wait --json`, handle each result, and run the guarded merge on `merge_eligible`.
During the review, a wait reports the draft's feedback and failing checks, and never `merge_eligible`.

The person can skip a running review. The SuperAgent records the skip, which marks the PR ready with no comment.
`operator pr round` and `operator pr ready` then refuse with `internal_review_ended`. Stop the review and continue with this step.
