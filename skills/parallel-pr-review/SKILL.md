---
name: parallel-pr-review
description: Use when reviewing several pull requests at once, one agent per pull request, or a pull request stack, and summarizing the verdicts or posting them to Slack.
compatibility: Requires Herdr (HERDR_ENV=1), the gh CLI, Claude Code agents, and the pr-review skill in the project.
---

# Parallel pull request review

Each pull request gets one Claude agent in its own Herdr worktree, and the agent runs `pr-review`.
You read their results, verify each verdict on GitHub, and write one bullet per pull request.
GitHub is the source of truth, and an agent report is a claim.

The agents base every review on the user's opinions in `~/OPINIONS.md`.
Each agent reads that file before it reviews, and the prompt below says so.

## Inputs

- Pull requests, as numbers or URLs, with optional short titles. Keep the order.
- Optional Slack target, a thread URL or a channel. Without one, skip step 7.
- Optional setup steps, for example `bun install` and a copy of the untracked `.env*` files from the main checkout. The default is the dependency install of the lockfile.
- Event mode. `verdict` (default) uses the event rule in step 3 of the prompt. `comment` posts `COMMENT` on every pull request.

Agents post with no second approval.
Get the user's authorization first, and keep their exact words for the prompt.

Keep a ledger file in your scratch directory with each value you create: PR number, ref, branch, worktree path, workspace id, pane id, agent name.
Cleanup removes only what the ledger names.

## 1. Read the pull requests

Load the `herdr` skill. Run `gh api user --jq .login`, then for each pull request:

```sh
gh pr view <n> --json number,title,url,author,state,headRefName,headRefOid,baseRefName
```

- Skip a pull request that is not `OPEN`, and tell the user.
- A `baseRefName` that is the `headRefName` of another listed pull request makes a stack. That agent reviews only against its own base.
- On your own pull request GitHub refuses `APPROVE` and `REQUEST_CHANGES`, so use `COMMENT`.

## 2. Create the worktrees

```sh
git fetch origin
git fetch origin "+refs/pull/<n>/head:refs/remotes/origin/pr/<n>"
herdr worktree create --cwd "$PWD" --branch review/pr-<n> --base origin/pr/<n> \
  --path ~/.herdr/worktrees/<repo>/review-pr-<n> --label "review #<n>" --no-focus
```

Read the workspace id and root pane id from the JSON result.
When the branch or path exists already, stop and ask the user.

## 3. Start the agents and send the prompts

```sh
herdr agent start review-<n> --kind claude --pane <pane-id> --timeout 60000
herdr agent prompt review-<n> "$(cat <prompt-file>)" --wait --until working --timeout 60000
```

Start the first agent alone as a smoke test, then the others in parallel.
Write each prompt to a file from this template. Drop the stack line when there is no stack.
In `comment` mode and on your own pull request, step 3 is "Post one review with event COMMENT."

```text
/pr-review <n>

The user authorized the post in these words: "<user's words>". Post without asking for approval.
This worktree is at the PR head <headRefOid>. Do not run gh pr checkout. The base is <baseRefName>.
PR #<n> is stacked on PR #<m>. Review only its own diff: gh pr diff <n>.

1. Setup: <setup steps>. Do not commit copied files.
2. Read ~/OPINIONS.md first. Base every finding on those opinions, then on the repo code style, and name the opinion that a finding breaks. Review with pr-review. Run lint, typecheck, and the tests that touch the changed code. Put a check that fails only on files this PR does not change in "noise", not in the review.
3. Post one review. Use APPROVE when you have no blocker, and COMMENT when you have blockers. Use REQUEST_CHANGES only for a strong breach of ~/OPINIONS.md or of an established best practice, or for a security concern, and name it in the review body.
4. Write pr-review-result.json in this worktree:
   {"number", "event", "url", "blockers": [], "nice_to_haves": [], "left_out": [], "noise": []}
   One sentence per item. left_out is what the pr-review caps cut.
5. Reply with the event and the review URL.

Do not commit, push, or change the PR branch.
```

## 4. Wait

Run `herdr agent wait review-<n> --timeout 3600000` for each agent, in parallel, in the background.
A wait that errors or prints nothing is a failure, not a finished review.
For a `blocked` agent, read `herdr agent read review-<n> --source recent-unwrapped --lines 60`.
Answer only setup, check, and post questions. Give the rest to the user.
With a Slack thread target, read the thread while you wait.

## 5. Verify on GitHub

Read each `pr-review-result.json` with `jq`. Then:

```sh
gh api --paginate repos/<owner>/<repo>/pulls/<n>/reviews \
  --jq '.[] | select(.user.login == "<login>") | [.submitted_at, .state, .commit_id, .html_url] | @tsv' \
  | sort | tail -n 1
```

The review must be new, on `headRefOid`, and in the state of the event in the result file.

- If there is no review, prompt the agent "Post the review now with the event rule of step 3, then write the result file." and wait again.
- If GitHub and the result file differ, use the GitHub values and note it.
- If there is no result file, use the GitHub review and the pane.

## 6. Summarize

One lead line with the verdict count and shared facts, then one bullet per pull request in the user's order.
A bullet is a review link, the short title, and the top one or two points.
Put the verdict at the front of each bullet only when verdicts differ.
Name shared noise once in the lead line.

```markdown
All 12 reviews are posted. **Every PR has changes requested.** Lint, typecheck and tests pass on all of them.

- [#1486](https://github.com/<owner>/<repo>/pull/1486#pullrequestreview-5523325175) shell: the narrow layout reads the window width, not the stage pane, and every status chip is green.
- [#1496](https://github.com/<owner>/<repo>/pull/1496#pullrequestreview-5523310135) Inventory empty: it says "No line items" with no check. Fold it into #1512 or change the copy.
```

In the terminal only, add notes: agents that needed a nudge, GitHub mismatches, `COMMENT` on your own pull requests, `left_out` findings with an offer to add them.

## 7. Post to Slack (optional)

Do this step only when the user gave a Slack target. Post the summary without the notes.
Load `slack:slack-messaging`, then post with `slack_send_message` and `channel_id`.
For a thread, add `thread_ts`. The thread URL `.../archives/<channel_id>/p1792003966909819` gives `1792003966.909819`.
Give the user the link of the posted message.

## 8. Clean up

Ask before you remove anything. Keep a worktree and tell the user why when any check fails:

- `git -C <path> status --porcelain` shows only `pr-review-result.json` and the setup copies.
- `git -C <path> log --oneline origin/pr/<n>..HEAD` is empty.
- `herdr agent get review-<n>` is `idle` or `done`.

```sh
herdr worktree remove --workspace <workspace-id> --force
git branch -D review/pr-<n>
git update-ref -d refs/remotes/origin/pr/<n>
```

A worktree outside the ledger is out of scope.
When the user asks to remove one, also require a merged PR (`gh pr list --head <branch> --state all`) or HEAD on a remote branch (`git branch -r --contains HEAD`), and keep its branch.
