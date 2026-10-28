# ADR-0015: Review requests own rounds and the CLI owns posting

## Status

Accepted - 2026-10-24.
Decided in #228 and #233.
Implemented in #253, with review rounds in #254 and Slack transport in #255.

## Context

Parallel reviews repeatedly stopped before posting, reviewed heads moved, and sessions rebuilt Slack ledgers by hand.
Assignment acceptance was the wrong lifecycle for an external PR review that could finish before merge.
Prompt-based posting permission also failed to reach host permission checks.

## Decision

A review request is a separate device record, not an assignment or a Slack work source.
Its origin is Slack or the optional reviewer of a PR assignment.
Both use the same reviewer, structured draft, head check, and CLI post path.
The request moves through queued, reviewing, posting, and watching, then ends approved, closed, or skipped.
An assignment-origin review always posts a comment, with a clear no-blockers result when appropriate, because the owner's account cannot approve its own PR.

The CLI owns the wait loop, resource creation, agent launch, head checks, GitHub posting, thread operations, and recorded next actions.
It resumes from the device database without a session ledger.
Transition guards prevent a second wait from repeating a GitHub post.
New commits, an author reply, an author-resolved thread, or a renewed review request start a round.
The reviewer checks its open threads, accepts valid pushback, and explains unresolved defects.
The CLI reopens a thread that the author resolved without fixing its defect.

One reviewer and worktree retain context for the request.
A missing pane gets a replacement whose brief names earlier drafts.
The worktree belongs to the PR repository's Herdr workspace, which the CLI opens if necessary.
It does not inherit the driving SuperAgent's repository context.
A request with no author activity for seven days while watching gets a visible stale flag, not a different lifecycle state.

The review skill always writes a draft and never posts directly or asks for post approval.
The CLI validates that draft, reads required CI checks, adds failing checks as blocker facts, and computes the review event.
Related tests and deliberate breaks of new guards remain reviewer-reported evidence that the CLI trusts.
A noise claim that cites a file changed by the PR is refused.
A repository without CI gets only the reviewer's reported checks.
The review rules prioritize the person's opinions, project skills, architecture, patterns, and best practices.
Findings are limited to three blockers and three nice-to-haves.

`REQUEST_CHANGES` requires a strong breach of the person's opinions, project skills, or architecture, named in the review body.
Otherwise, an open blocker permits only a comment, and no blocker permits approval.
Approval with an open blocker is refused.
The person's own PRs always receive comments.
An approved request stops watching later commits, while a renewed GitHub review request can start another round.

Before posting, the CLI compares the PR head with the reviewed commit.
A fast-forward updates the worktree and asks the same reviewer for the new commits and diff.
A force push requires review from the start.
After three head moves, the CLI posts against the last reviewed commit and states that limit in GitHub and Slack output.

Slack transport uses the agent's MCP tools, with no Slack token in the CLI.
The CLI schedules channel reads, filters registered repositories and GitHub authors through device policy, and records the channel cursor from raw ingested results.
It generates every reply and reaction, then gives the exact effect to the agent for transport and acknowledgement.
Pending effects survive a restart.
A skip applies to one PR, never an author-wide skip list.
Replies have a compact status, nonzero counts, and a review link, with at most three short blocker bullets and later-round progress.
Start and outcome reactions are additive, not replacements.
The four reactions mark review start, approval, requested changes, and comment outcomes.
The skill routes these transport actions and blocked-worker attention without recreating the workflow.

## Consequences

- Review requests need their own rounds and Slack effect records, but not a tracker or assignment-acceptance protocol.
- Reported local checks remain claims, while required CI results are independently observed facts.
- The head-move limit bounds review churn but can post against an older reviewed commit with an explicit warning.
- Slack effects cross a tool boundary and require acknowledgement, so the CLI does not claim exactly-once Slack delivery.
- Assignment reviewers cannot supply the approval that the PR merge gate requires.
- Stable global-command hooks must prepare the correct repository's worktree before a reviewer starts.

## Alternatives considered

- Reviewer assignments inside a Slack work source were rejected because review completion differs from assignment merge or report acceptance.
- A new reviewer for every round was rejected because it loses the request's code context.
- Direct skill posting and pasted permission grants were rejected because they create a second write path and do not solve host permission checks.
- Slack user or bot tokens in the CLI were rejected because the person chose MCP transport and replies under their account.
- Agent-composed Slack status and session ledgers were rejected because resumable state and mechanical output belong to the CLI.
- Per-project gate command settings and rerunning all checks before posting were rejected because CI already supplies required checks and repeating them adds cost.
- Author-wide skips were rejected because a one-PR exception must not silently exclude all work by one person.

Related: ADR-0001 and ADR-0003, next actions and state guards; ADR-0010, optional assignment-origin review; ADR-0005, repository workspace identity; ADR-0011, reviewer resources; ADR-0007, stable global-command plugin; ADR-0014, both host integrations.
