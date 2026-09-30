# The integrated pull request flow, and what Operator needs to automate it

This document has three parts.
Part 1 records a flow that one main agent and a crew of sub-agents ran by hand to build a release in another repository.
Part 2 is a short map of what Operator does today.
Part 3 lists the deltas between the two.

The flow ran in a private repository, so this copy names no repository, issue, or file of it.
A claim about Operator names the Operator file that shows it, at commit `62038e0`.
A claim marked "unverified" was not checked against a run.

## Part 1. The flow

### Roles

The main agent plans, asks the user for decisions, writes the briefs, reviews each diff, integrates the commits, and publishes.
Each sub-agent does one issue in its own Herdr worktree, makes one commit, and writes one report.
Read-only review agents run as native sub-agents of the main agent, not in Herdr.
The user makes the design decisions and says yes before anything is published.

### The delivery shape

One pull request carries one release of eleven issues.
Each commit closes exactly one issue, in blocking order.
Each commit passes the gate on its own, so a reviewer can check out any commit.
The PR body starts with "Review this PR one commit at a time", then one line per commit: the subject as a link to the commit in the PR, and the issue it closes.
The body then says where to start reading, what looks wrong and is not, each behavior change, what was verified with exact commands, what is not verified, and the tickets for what is not in this PR.
Each issue gets a comment "Done in <commit link> (PR #<n>)".
The links are written last, because a rebuilt history changes every SHA.

This shape is Matt Pocock's `implement-spec` skill (`.agents/skills/implement-spec/SKILL.md`) plus a commit-per-issue rule.
`implement-spec` also asks for one branch, implementer sub-agents in their own worktrees, a merge step, one `code-review` at the end, and worktree cleanup.

### Steps

1. **Plan and ticket.**
   Read the spec.
   Create one issue per task with `gh issue create --label ready-for-agent`, in commit order, so the numbers read in order.
   Link each one to the parent with `gh api --method POST repos/<o>/<r>/issues/<parent>/sub_issues -F sub_issue_id=<db id>`.
2. **Decide before dispatch.**
   A task with an open design choice goes to the user first, with a recommendation and the rejected options.
   The answer goes into the issue's "Decision" section before a sub-agent starts.
3. **Build the integration branch.**
   Make a new branch from `main` and cherry-pick the commits that already exist.
   Reword a commit with `git commit --amend -F <file>`.
   Check that `git diff <old branch> HEAD --stat` is empty.
4. **Dispatch in phases by file overlap.**
   Tasks that touch different files run in parallel.
   A task that shares a folder with another task waits, or it runs in two phases: phase A now, phase B after the other task lands, rebased and amended into the same one commit.
   The commands, on Herdr 0.9.1:
   - `herdr worktree create --cwd "$PWD" --branch agent/<n>-<slug> --base <integration branch> --label "<n>" --no-focus`, which returns `.result.root_pane.pane_id`.
   - `herdr agent start w<n> --kind claude --pane <pane> --timeout 60000 -- --permission-mode auto`.
   - `herdr agent prompt w<n> "Read <common.md>, then read <n>.md, and do the work in the brief."`
   - A background shell of `herdr agent wait w<n> --timeout <ms>`, so the main agent wakes on completion. The user rejected a blocking foreground wait.
5. **Write the brief.**
   A shared rule block plus one brief per issue.
   The brief names the issue, the files the agent may touch, the order of steps, the verify commands, the user rules, a report path, and a word limit.
   A good brief also names the candidates to change, the rule to apply, and the decisions the agent must report.
6. **Review each diff.**
   The report is a claim.
   Read `git diff <integration> agent/<n>-<slug>`, check the risky parts, and send fixes back to the same agent with `herdr agent prompt`.
   The agent keeps its context and amends its one commit.
   The real catches:
   - One task deleted what looked like the only doc of a setting. The agent showed that the README had it, and the agent was right.
   - One task made one bad API item fail a whole batch. It went back for a per-item skip with a red-then-green test.
   - One task pushed a test file over the `max-lines` limit. The main agent linted each commit in a spare worktree to find the commit.
   - One task added explicit return types right after an earlier task removed that pattern. Only a reader of both commits sees this.
7. **Integrate.**
   Cherry-pick the agent commits in issue order, then run the full gate on the integration branch.
8. **Two-axis review.**
   The `code-review` skill runs a Standards agent and a Spec agent in parallel.
   A narrow scope finished in 2 to 4 minutes: the new commits in depth, the reviewed commits only for gaps.
9. **Fix the findings, per commit.**
   One agent makes one `git commit --fixup=<sha>` per target commit.
   The main agent reviews each fixup, checks that the target commits share no file, and runs `GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash origin/main`.
10. **Gate at every commit.**
    In a spare worktree, `git checkout --detach <sha>` and run the gate, for each commit.
11. **Publish, after the user says yes.**
    Push a new branch with no force push, and open the PR.
    Write the body with the per-commit links.
    Close the old PR with a pointer to the new one.
    Comment the commit link on each issue.
12. **Clean up.**
    `herdr worktree remove --workspace <id> --force` for each worktree the main agent created, and only those.
    The local `agent/*` branches stay.

### The report contract

Every report gives the commit SHA, the change per file, every behavior change as a list or "none", the gate result with exact commands, and what was not done.
The behavior change list is required because one "no behavior change" claim was wrong.
One refactor report found three behavior changes: a malformed optional field now dropped, a boundary value now classed as malformed, and a record with no ID now skipped instead of sent.

### Gotchas

- The Herdr agent state `done` is not a result. The report file at a known path was the reliable channel.
- Claude Code in a new worktree needs `bun install` first, and `--permission-mode auto` so it does not stop on a permission prompt.
- One sub-agent wrote a file outside its worktree, into the parent folder of the Herdr worktrees. It removed the file itself. Nothing checked for this.
- In zsh, `$c:path` reads as a history modifier. Write `"${c}:path"`.

## Part 2. What Operator does today

Operator is a CLI with recorded state (one SQLite file) and an `operator` skill that drives it.
The skill runs `operator crew next` on every turn and takes the first action it offers (`skills/operator/COORDINATION.md`).
The loop for one piece of work:

1. `crew own` gives an owner token.
2. `work register` records items from a spec, a ticket, or a wayfinder map, with scope, acceptance requirements, write paths, commands, fixed inputs, and `dependsOn` (`skills/operator/REGISTRATION.md`).
3. The frontier offers work whose dependencies reached accepted completion, within `crew.maxActiveAgents`, with one slot kept for review (ADR 0004).
4. `attempt dispatch --commit <sha>` creates a Herdr worktree on branch `operator/<key>-<short>`, writes the brief from the registered fields, starts the agent, and submits the prompt. Each effect is recorded (ADR 0005).
5. The Operative acknowledges, may raise questions, and submits a result JSON with its checks and its pull request (ADR 0006, ADR 0007).
6. The submission registers a review assignment. A separate reviewer Operative runs `code-review` with both axes as parallel native sub-agents (ADR 0007).
7. The Operator disposes of each finding. A correction goes to a fresh Operative as a rework cycle, within limits (ADR 0008).
8. `work accept` checks the recorded evidence and the pull request head.
9. `tracker record` writes a resolution comment, closes the ticket, and amends the map (ADR 0009).
10. `cleanup close` and `cleanup remove` end the process and remove the worktree, each behind proof and approval (ADR 0010).
11. The `operator.wake` Herdr plugin prompts the idle Operator when a crew agent changes state and `crew next` has work (`skills/operator/WAKE.md`, `herdr/wake.ts`).

## Part 3. The deltas

### Already covered

| Flow need | Operator today |
| --- | --- |
| Create a worktree, start the agent, send the prompt | `attempt dispatch`, staged and recorded (ADR 0005) |
| A registry of the worktrees the Operator made, so cleanup never touches the user's own | Each attempt records its Herdr workspace, pane, and checkout. Cleanup proves each name belongs to the attempt (ADR 0010) |
| A completion signal that wakes the orchestrator | The `operator.wake` plugin and the `data.waits` of `crew next` |
| A reliable result channel, not the Herdr `done` state | `attempt submit` with a JSON result, and `attempt acknowledge` for receipt |
| `bun install` in a new worktree | The prompt says `bun install --frozen-lockfile` first (`modules/operative-dispatch/plan.ts`) |
| Dependencies and parallel capacity | The frontier and `crew.maxActiveAgents` (ADR 0004) |
| A question in the middle of the work, and escalation to the user | `question raise`, the escalation triggers, `question answer` (ADR 0006) |
| A two-axis review with parallel axes | A reviewer Operative with native sub-agents, and overlapping windows checked (ADR 0007) |
| "The agent was right" on a finding | `review dispose` with `rejected` and the refuting evidence |
| The user's yes before an effect | `approval grant`, bound to the action and its revision |
| Close each issue | `tracker record` with the `completion` step |

### Gaps that no ADR blocks

**G1. Spec to issues, and issues to registration.**
Operator never creates an issue.
`modules/github-tracker/main.ts` reads issues and comments, and `tracker-update` writes comments and closes.
Matt's `to-tickets` creates issues with native blocking links, but registration input is still a hand-written JSON file.
Needed: register a source from a parent issue, reading its sub-issues as items and `dependencies/blocked_by` as `dependsOn`, in issue order.

**G2. File overlap in the frontier.**
`permissions.writePaths` appears only in the brief text (`modules/operative-dispatch/plan.ts:284`).
The frontier reads dependencies and capacity, and nothing else.
Needed: the frontier holds an assignment whose write paths overlap a running one, and says why.
The phase A and phase B split has no model, because `dependsOn` holds a whole assignment.
Two assignments, or a partial dependency, are the two options. This needs a decision.

**G3. A write-path check on the result.**
No step compares the diff with `writePaths`.
The flow did this check by reading the diff.
Needed: `attempt submit` or the review lists each file of `git diff --name-only <base>..<result>` outside the write paths, and blocks on it.
A write outside the worktree is harder to see. Its detection is unverified.

**G4. A behavior change list in the submission.**
The submission has `concerns` and `decisions` (`modules/crew-state/submission-input.ts`), and no behavior change field.
Needed: a required `behaviorChanges` list, where an empty list is an explicit "none".
The PR body reads it.

**G5. The gate at every commit of the delivered history.**
Operator records the checks of one submission at its own head.
It never runs the gate on the integrated history, one commit at a time.
Needed: a recorded per-commit gate on the integration branch before publish, and again after an autosquash.

**G6. PR assembly and the issue links.**
Operator does not open a PR and does not write its body.
`tracker record` writes the resolution comment at acceptance, before the final SHAs exist.
Needed: a publish step that renders the body from the recorded submissions (subject, commit link, issue, behavior changes, checks), comments the commit link on each issue, and writes the links again after any history change.

**G7. The Claude Code permission mode.**
`startAgent` passes only `--model` and `--effort` (`modules/herdr-control/main.ts`, `startAgent`).
The flow needed `--permission-mode auto`.
Whether an Operative stops on a permission prompt today is unverified. The live probe is the place to prove it.

**G8. A decision before dispatch.**
A planning item (for example `grilling`) is accepted with no attempt and no decision text.
The flow put the user's answer into the issue before dispatch.
Needed: planning acceptance records the decision with its exact words and authority, and the dependents receive it as a fixed input.

**G9. The fixup overlap check.**
Before an autosquash, the flow checked that the target commits share no file.
Needed as part of the integration step, whichever design C2 picks.

### Conflicts with a recorded decision

Each of these needs a decision, and an ADR, before automation.

**C1. The delivery unit.**
The flow delivers one PR with one commit per issue.
Operator delivers one PR per assignment.
A code submission states an open PR with its head commit, or `authority-missing` (`modules/crew-state/submission-input.ts`, `pullRequest`).
Acceptance blocks with `pr_authority_missing`, `pr_head_required`, or `pr_head_changed` (`modules/crew-state/acceptance.ts:211-231`).
Most other conflicts follow from this one, so settle it first.

**C2. Who integrates.**
In the flow the main agent cherry-picks, amends, and autosquashes.
Operator "holds no worktree of its own" and never edits a result (ADR 0008, `skills/operator/REVIEW.md`).
The `integration` rework reason combines revisions, but it names them only as text.
The options: the CLI performs the mechanical steps (cherry-pick, autosquash) and records them, and a conflict becomes an assignment, or integration is its own assignment kind for an Operative.

**C3. Where review looks.**
Operator reviews each submission alone, from its own base.
The undone-pattern catch is visible only to a reader of both commits.
The flow had the main agent read each diff, then ran one two-axis review over the whole branch, narrow on the new commits.
Needed: a review of the integrated branch, either in place of the per-assignment review or after it.
The skill rule "Never accept a result you reviewed yourself" does not stop the Operator from reading a diff, but no step records that reading.

**C4. Send-back to the same agent.**
In the flow, a fix went back to the agent that wrote the commit, and it amended with full context.
Operator ends the attempt at submission and sends a correction to a fresh Operative (ADR 0008, CONTEXT.md "Rework cycle").
ADR 0008 rejects repair by the reviewer and by the Operator, but it does not name repair by the producer as a rejected option.
The trade-off is independence against cost and speed. A fresh Operative reads the whole brief again.

**C5. Cleanup after a cherry-pick.**
`cleanup remove` needs a remote copy of every commit of the attempt, through `git branch --remotes --contains <commit>` (`modules/operative-cleanup/inspect.ts:45-50`).
A cherry-pick and an amend make new SHAs, so the agent's own commits never reach a remote, and removal blocks.
Needed: accept a patch-equivalent commit on a pushed branch (`git cherry`, or a patch ID) as preservation, or push the agent branches.

**C6. The brief comes only from registration.**
`skills/operator/BRIEFING.md` says "You do not write the prompt".
The flow's briefs held per-task candidates, rules, and verification steps.
The registered `approvedScope` and a `fixedInputs` path can carry all of it, so this is a convention, not new code.
The shared rule block becomes a fixed input on every item, or project instructions.
