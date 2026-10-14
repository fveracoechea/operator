---
name: parallel-pr-review
description: Use when reviewing several pull requests at once, one agent per pull request, or a pull request stack, and summarizing the verdicts or posting them to Slack.
compatibility: Requires Herdr (HERDR_ENV=1), the gh CLI, Claude Code agents, and the pr-review skill in the project.
---

# Parallel pull request review

This skill runs one `pr-review` for each pull request at the same time, and returns one short bullet for each pull request.
Each review is one Claude agent in its own Herdr worktree.

You are the orchestrator.
The agents read the code and post the reviews.
You read their short results, verify each verdict on GitHub, and write the summary.
GitHub is the source of truth for a verdict, and an agent report is a claim.

## Inputs

- The pull requests, as a number or a URL each, with an optional short title. Keep the order that the user gave.
- An optional Slack target, as a thread URL or a channel. Post to Slack only when the user gave one.
- Optional setup steps for each worktree, for example `bun install` and a copy of the untracked `.env*` files from the main checkout. With no steps, the agent installs the dependencies with the package manager of the lockfile.
- An optional event mode. The default `verdict` mode approves a pull request with no blocker, and requests changes on a pull request with one or more blockers. The `comment` mode posts every review with the `COMMENT` event.

Each agent posts its review with no second approval, so get the authorization before step 1.
When the request does not say to post the reviews, ask once.
Keep the exact words of the user that authorize the post, because each agent prompt quotes them.

## Run ledger

Write a ledger file in your scratch directory before you create the first worktree.
Give it one entry for each pull request: the number, the fetched ref, the branch, the worktree path, the workspace id, the pane id, the agent name, the result file path, and the files that setup copied.
Add each value when you create it.
Cleanup removes only what the ledger names, and the ledger survives a context compaction.

## Steps

### 1. Read the pull requests

Load the `herdr` skill and check that `HERDR_ENV` is `1`.
Run `gh api user --jq .login` to get your login.
For each pull request, run `gh pr view <n> --repo <owner>/<repo> --json number,title,url,author,isDraft,state,headRefName,headRefOid,baseRefName`.

- A pull request that is not `OPEN` gets no review. Tell the user.
- A pull request whose `baseRefName` is the `headRefName` of another pull request in the list is part of a stack. Its agent reviews only the diff against its own base.
- GitHub refuses `APPROVE` and `REQUEST_CHANGES` on your own pull request. When `author.login` is your login, that pull request gets the `COMMENT` event.

Done when each pull request has its head commit, its base branch, and its event.

### 2. Create one worktree for each pull request

```sh
git fetch origin
git fetch origin "+refs/pull/<n>/head:refs/remotes/origin/pr/<n>"
herdr worktree create --cwd "$PWD" --branch review/pr-<n> --base origin/pr/<n> \
  --path ~/.herdr/worktrees/<repo>/review-pr-<n> --label "review #<n>" --no-focus
```

The pull request ref works for a pull request from a fork too.
Check that `git rev-parse origin/pr/<n>` gives `headRefOid`.
Read the workspace id and the root pane id from the JSON result, and write them to the ledger.

When the branch or the path exists already, an earlier run made it.
Do not use it again and do not remove it.
Apply the checks in [CLEANUP.md](CLEANUP.md) and ask the user what to do.

### 3. Start the agents

Run `herdr agent start review-<n> --kind claude --pane <pane-id> --timeout 60000`.
Start the first agent alone as a smoke test.
When it is ready, start the other agents in parallel.

### 4. Send the prompts

Read [AGENT-PROMPT.md](AGENT-PROMPT.md), and write one prompt file for each pull request.
Send each one with `herdr agent prompt review-<n> "$(cat <prompt-file>)" --wait --until working --timeout 60000`.
This command returns when the agent starts to work, so all the reviews run at the same time.

### 5. Wait for the agents

For each agent, run `herdr agent wait review-<n> --timeout 3600000` as a separate background command, in parallel.
A wait returns when the agent is `idle`, `done`, or `blocked`.
A wait that exits with an error, or with no output, is a failure and not a finished review.
Read `herdr agent get review-<n>` to learn the state.

For a `blocked` agent, read `herdr agent read review-<n> --source recent-unwrapped --lines 60`.
Answer a question only when it is about the setup steps, a read, a check, or the review post.
Give every other question to the user.

When the user gave a Slack thread, read it while you wait, as [SUMMARY.md](SUMMARY.md) says.

Done when each agent is `idle` or `done`, and each wait has reported.

### 6. Verify each verdict on GitHub

Read each result file.
Then get the latest review that you posted on each pull request:

```sh
gh api --paginate repos/<owner>/<repo>/pulls/<n>/reviews \
  --jq '.[] | select(.user.login == "<login>") | [.submitted_at, .state, .commit_id, .html_url] | @tsv' \
  | sort | tail -n 1
```

Always use `--paginate`, because a pull request with many reviews shows nothing on page one.
The review is good when it was submitted after the run started, its state matches the event (`APPROVED`, `CHANGES_REQUESTED`, or `COMMENTED`), its `commit_id` is `headRefOid`, and its URL is the URL in the result file.

- When there is no review, the agent did not post. Prompt it to post now, as [AGENT-PROMPT.md](AGENT-PROMPT.md) says, and wait again.
- When the review and the result file do not agree, GitHub is correct. Write the GitHub values in the summary, and put the mismatch in the notes.
- When there is no result file, use the GitHub review, and read the pane for the findings.

Done when each pull request has one verified review.

### 7. Write the summary

Read [SUMMARY.md](SUMMARY.md).
Give the summary to the user, and post it to Slack when the user gave a target.

### 8. Clean up

Read [CLEANUP.md](CLEANUP.md).
Ask the user before you remove a review worktree.

## Worktrees from other runs

A worktree that the ledger does not name is out of scope.
When the user asks you to remove old worktrees, apply the checks in [CLEANUP.md](CLEANUP.md), and remove only a worktree whose work is safe.
