---
name: pr-review
description: Use when asked to review a pull request by number or URL, or when a review brief names this skill.
---

# Pull request review

This skill writes one review draft.
It never posts a review, a comment, or a thread reply.
The only post path is `operator review post <pr-url> --json`, which checks the draft, the live PR head, and the required CI, computes the event, and posts.

A run reads the diff on three axes, Standards, Spec, and Design.
The review rules rank evidence in this order: the person's opinions in the `my-opinions` skill, the project skills, the architecture, the existing patterns, then general best practice.

## 1. Find the head and the draft location

With a review brief, the worktree is already at the PR head on a local branch.
Do not run `gh pr checkout`, commit, push, or change the PR branch.
The brief names the draft file, which lives outside the worktree.

Without a brief, the person runs this skill alone.
Run `operator review add <pr-url> --json`. The result names the `draft` file.
An unregistered repository refuses. Tell the person to register its controlling checkout.

Run `gh pr view <number> --repo <owner>/<repo> --json headRefOid,baseRefName,mergeable,mergeStateStatus`.
The draft's `reviewedCommit` is that full `headRefOid`.

## 2. Check the base before the diff

A PR can be replaced by work that the base already holds.
Do this check before you gather findings, because a rewrite request on a replaced PR wastes the author's time.

Read `mergeable` and `mergeStateStatus` from step 1.
If `mergeable` is `UNKNOWN`, read it again after a few seconds. The base comparison below does not depend on it.

Fetch the base from the remote of `<owner>/<repo>`, which is not always `origin`.
Find it with `git remote -v`: it is the remote whose URL names `<owner>/<repo>`.
Then compare the base with the head:

```sh
git fetch <remote> <base>
git rev-list --count HEAD..<remote>/<base>
git diff --name-only -z <remote>/<base>...HEAD \
  | xargs -0 -r git log --oneline "$(git merge-base HEAD <remote>/<base>)..<remote>/<base>" --
```

An empty file list from `git diff` means that the PR makes no net change against its merge base.
Then `xargs -r` runs no log. Say so in a blocker and recommend to close the PR.

For each base commit that changes the same files, find its merged PR and compare the two changes.
A PR is superseded only when the base already holds the same change or a newer version of it, for example a newer bump of the same vendored skill.
A PR that is behind, `CONFLICTING`, or `DIRTY` is not superseded for that reason alone.

For a superseded PR, write one blocker that names the merged PR, with the evidence in `detail`, and recommend to close the PR.
Put this result first in the `summary`. Skip the detailed findings, because they do not apply to replaced code.
Never close the PR yourself.

For a PR that is still needed but conflicts with the base, review it as usual and add a nice to have that names the conflicting base change.

## 3. Gather findings

Load the `my-opinions` skill and the project skills that the changed code needs.
The `code-review` skill does Standards and Spec.
Invoke it when the agent lists it, give it `baseRefName` as its fixed point, and read the diff yourself when it is absent.

The design pass asks where the functionality landed, which module owns the use case, and what a caller must now know.
Read [`DESIGN.md`](DESIGN.md) and run that pass whether or not `code-review` is available.

Run the tests that touch the changed code.
For each new guard, break it on purpose and run its test, then restore the code.
Report each run in `checks` with its command and exit code.
A guard break that exits 0 did not prove its guard, and the post refuses it.

## 4. Verify every claim against its source

Treat the PR body and the commit messages as claims, and check each one against the artefact.
Check behaviour by running the command and reading its output.
Drop every claim you cannot verify.

## 5. Rank the findings and cut to the caps

A blocker is a defect the author fixes before the PR merges.
Keep the three that matter most.
A nice to have is a follow-up, or a small fix the author may take before merge.
Keep the three that matter most.
Drop the rest. The three axes compete for the same caps.
A design finding on a new interface that later callers copy is a blocker, and a design finding inside one implementation is a nice to have.

Name a `breach` on a blocker only for a strong breach of the person's opinions, a project skill, or the architecture.
Give the rule in its own words. A named breach is the only cause of a request for changes.

## 6. Write the draft

Read [draft.md](draft.md) for the fields, the limits, CI noise, and the event that the CLI computes.
Anchor each finding with `path` and `line` only on a line inside a diff hunk of a changed file.
Run `gh api repos/<owner>/<repo>/pulls/<number>/files --paginate --jq '.[] | .filename, .patch'` and count the right-side lines from each hunk header.

## 7. Post through the CLI

Run `operator review post <pr-url> --json`.
A refusal names its cause. Correct the draft and run the post again.
A `review_head_moved` refusal means that the PR changed after your review. Tell your SuperAgent, or the person when you run alone, and stop.
Report the posted event and the review URL.

## Finding text

State the defect in one sentence, then give the evidence.
A blocker's `short` field has at most six words, for one-line summaries.
Add a short fenced code example with a language tag only when it shows the defect or the correction more clearly than prose.
Ground every snippet in code you read at the reviewed commit, and mark a proposed correction as illustrative.

## Voice

Write the way one colleague writes a note to another colleague, give the defect with its file and line, and stop on the last finding.
Apply `no-slop` rules 7, 13, 18, 20, 22, 23, 25, 32 and 33, which are stable ids.
Read [`../no-slop/SKILL.md`](../no-slop/SKILL.md) for the text of each rule.
