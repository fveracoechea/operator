# The agent prompt

Each agent gets one prompt, and the prompt carries all the facts the agent needs.
You do not need to read the `pr-review` skill, because the prompt states each fact that changes the default of that skill.

## Template

Fill each `<...>` value from step 1 and from the ledger.
Leave out the stack line when the pull request is not part of a stack.

```text
/pr-review <n>

The user asked for this review and authorized the post in these words: "<words of the user>".
This is the pre-authorization for this session. Post the review without asking for approval.

This worktree is on the branch review/pr-<n> at the head of the pull request, <headRefOid>. Do not run gh pr checkout.
The base branch is <baseRefName>.
PR #<n> is part of a stack, and its base is PR #<m>. Review only the changes of this pull request, with gh pr diff <n> or git diff origin/<baseRefName>...HEAD. Do not review code from lower pull requests in the stack.

Do these steps in order:
1. Setup: <setup steps>. Do not commit the files that setup copies.
2. Review the pull request with the pr-review skill. Run the lint, the typecheck, and the tests that touch the changed code. A check that fails only on files that this pull request does not change is shared noise. Put it in "noise" and keep it out of the review.
3. Post one review with the event <event rule>.
4. Write the result file <worktree>/pr-review-result.json in the shape below.
5. Reply with one line: the event and the review URL.

Do not commit, push, or change the pull request branch.

Result file shape:
<result file shape>
```

## The event rule

- In `verdict` mode, write "`APPROVE` when you have no blocker, and `REQUEST_CHANGES` when you have one or more blockers".
- In `comment` mode, and on your own pull request, write "`COMMENT`".

The `pr-review` skill posts `COMMENT` by default, so the prompt always states the event.

## The result file

The agent writes this file after it posts the review, so no check of the review sees it.

```json
{
  "number": 1486,
  "event": "REQUEST_CHANGES",
  "url": "https://github.com/<owner>/<repo>/pull/1486#pullrequestreview-5523325175",
  "blockers": ["One sentence for each blocker in the review."],
  "nice_to_haves": ["One sentence for each nice to have in the review."],
  "left_out": ["One sentence for each finding that the caps of pr-review cut."],
  "noise": ["One sentence for each failing check that this pull request does not cause."]
}
```

The file is your main input for the summary.
Read it with `jq` or Bun, not with a filter over the pane.

## The nudge

An agent that stops before it posts gets this prompt:

```text
The user authorized the post in these words: "<words of the user>". Post the review now with the event <event rule>, write <worktree>/pr-review-result.json, and reply with the review URL.
```

Send it with `herdr agent prompt review-<n> "<text>" --wait --until working --timeout 60000`, then wait for the agent again.
