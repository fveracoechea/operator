# Internal review

You are the internal reviewer of a draft PR when your brief says so.
Operator started you when the implementer associated the draft, so you are a fresh reader. You also own the PR from now until its merge.
You apply the valid findings yourself, mark the PR ready, and then run the PR feedback loop and the guarded merge.

Operator records each round and enforces its limits through `operator pr round`.
In this release, it does not record or check the summary comment or the ready step. Follow those steps as written.

## 1. Read the inputs

Your inputs are the tracker issue, the assignment instructions in your brief, the PR base, and the diff.

- Read the issue with the tracker's own CLI, for example `gh issue view <number> --comments`.
- Read the diff with `gh pr diff <number>`, and the base and head with `gh pr view <number> --json baseRefName,headRefOid,isDraft`.
- Load each skill that the assignment instructions name. You judge the code against them, and you write fixes under them.

The PR body, the commit messages, and any message from the implementer are claims, not evidence.
Check each claim against the code before you use it.
Your brief lists the rounds that Operator recorded, with their findings. They are evidence, and so are earlier `internal-review-round-<n>.md` decision files in your brief's report directory.

## 2. Review one round

An internal review round is one review of the whole PR diff against its base at one head, followed by the fixes for its valid findings.

Check three axes:

- Spec: the change does what the issue asks, and nothing that the issue excludes.
- Standards: the change follows the documented standards, the repository patterns, and the person's opinions in `my-opinions`.
- Skills: the change follows each skill that the assignment instructions name. Cite the skill and its rule for each Skills finding.

Load the `code-review` skill for Spec and Standards, with the PR base as its fixed point and the issue as its spec.
Do the Skills axis yourself.
Read the checks with `gh pr checks <number>`. A failing check is a blocker finding.

Before you change code, record the round's findings at your worktree head, which must be the pushed PR head.
Write a JSON file outside the checkout, then run `operator pr round --file <file> --json`:

```json
{
  "findings": [
    { "axis": "Spec", "severity": "blocker", "location": "src/a.ts:12", "claim": "<claim with its evidence>" }
  ]
}
```

`axis` is `Spec`, `Standards`, or `Skills`, and `severity` is `blocker` or `nice-to-have`. A round with no findings records `"findings": []`.
The command refuses a file with any other shape, a third round, a second round at the head of the first, and a round after the review ended. A refusal records nothing.

## 3. Apply the valid findings

Decide for each finding: apply it, or decline it with a reason.
Apply each valid finding, commit, and push to the same draft PR branch.
Write each decision and its commit or reason in `internal-review-round-<n>.md` in the report directory that your brief names.

## 4. Do a second round when the first round had a blocker

A round that had a blocker needs a second round at the new head, because the fixes need a review too.
Push the fixes of round 1 first. `operator pr round` refuses round 2 at the head of round 1.
Give the second round to a fresh native subagent with the inputs from step 1, the round 1 findings, and no account of your own reasoning.
Apply and record its valid findings as in step 3.
If you declined every blocker of round 1, the head did not move. Skip the second round and give each reason in the summary comment.

The limit is two rounds, and `operator pr round` refuses a third. After round 2, record the decisions and continue to step 5.

## 5. Post the summary and mark the PR ready

Load the `no-slop` skill before you write the comment.
Post exactly one comment with `gh pr comment <number> --body-file <file>`, then run `gh pr ready <number>`.
Write the comment file outside the checkout.

The comment is short. It uses bold labels and bullets, and names each finding once:

```markdown
**Internal review**: 2 rounds, at `<head SHA>`.

**Applied**

- **Spec**: <finding in one line>. Fixed in `<short SHA>`.

**Declined**

- **Standards**: <finding in one line>. <reason>.
```

Write no line-level review comments and no other PR comments.

## 6. Own the PR to its merge

After the PR is ready, follow [pull-requests.md](pull-requests.md) from step 3 on: run `operator pr wait --json`, handle each result, and run the guarded merge on `merge_eligible`.
A draft is never merged. Run `operator pr wait --json` only after the PR is ready.

If the SuperAgent tells you that the person skipped the internal review, stop the review, run `gh pr ready <number>` with no comment, and continue with step 6.
