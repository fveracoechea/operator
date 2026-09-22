---
name: pr-review
description: Use when asked to review a pull request by number or URL, or to post review comments on a pull request.
---

# Pull request review

This skill posts one GitHub review.
The `code-review` skill does the analysis on two axes, Standards and Spec.
Invoke it when the agent lists it, and read the diff yourself when it is absent.

## Contract

A run posts one review through `gh api`, with a single-line body.
Each inline comment sits on the exact line, opens with `Blocker.` or `Nice to have.`, and gives the evidence you gathered.
A run that finds nothing posts the body alone.

## Process

### 1. Resolve the pull request and gather findings

Run `gh pr view <number> --repo <owner>/<repo> --json headRefOid,baseRefName`.
The value of `headRefOid` becomes the `commit_id` of the review.
Run `gh pr checkout <number>`, because `code-review` diffs the local `HEAD`.
Invoke `code-review` and give it `baseRefName` as its fixed point.

### 2. Verify every claim against its source

Treat the pull request body and the commit message as claims, and check each one against the artefact itself.
Check a claim about a published package against the tarball, so run `npm pack <name>@<version>` and read the extracted files.
Check a claim about a route against the route file.
Check a claim about behaviour by running the command and reading its output.
Drop every claim you cannot verify.

### 3. Rank the findings and cut to the caps

A blocker is a defect the author fixes before the pull request merges.
Keep the three that matter most.

A nice to have is a follow-up, or a small fix the author may take before merge.
Keep the two that matter most.

Drop the rest.
Both caps are ceilings, and the evidence from step 2 decides what earns a comment.
A run can end this step with no blockers, with no nice to haves, or with nothing at all.

### 4. Anchor each comment to a line

Run `gh api repos/<owner>/<repo>/pulls/<number>/files --paginate --jq '.[] | .filename, .patch'`.
Count the right-side line numbers from each hunk header to get the value of `line`.
GitHub omits `patch` on a large file and on a binary file, so read that file at `headRefOid` and count its lines instead.
Every line sits inside a hunk of the diff, and one bad line returns 422 and rejects the whole review, so check each comment before you post.

### 5. Show the findings and wait

Print the body and every comment in full, and give the file and the line of each one.
Post after the user approves, or post at once when the user pre-authorised it in this session.

### 6. Post one review

Write the payload to a file, then send the file.
Leave `comments` out when you have none.

```json
{
  "commit_id": "<headRefOid>",
  "event": "COMMENT",
  "body": "<one line>",
  "comments": [{ "path": "src/route.ts", "line": 42, "side": "RIGHT", "body": "Blocker. ..." }]
}
```

Run `gh api repos/<owner>/<repo>/pulls/<number>/reviews --method POST --input review.json --jq .html_url`, and report the URL that it returns.

## Comment shape

State the defect in one sentence after the opening word, then give the evidence.
A simple finding stays as short prose.
Add structure only when it helps the author act.

Add a short fenced code example with a language tag when it shows the defect, the correction, or the interface more clearly than prose.
Ground every snippet in code you read at `headRefOid`.
Mark a proposed correction or interface as illustrative, so the author does not read it as the implementation you verified.
Keep a proposal to the shape of the change, never a full replacement implementation.

Flat bullets hold independent evidence, constraints, or requested changes.
A numbered list holds steps whose order matters.

## Voice

Write the way one colleague writes a note to another colleague, give the defect with its file and line, and stop on the last finding.

Apply `no-slop` rules 7, 13, 18, 20, 22, 23, 25, 32 and 33, which are stable ids.
Read [`../no-slop/SKILL.md`](../no-slop/SKILL.md) for the text of each rule.
