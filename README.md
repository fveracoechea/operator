# Operator

Personal skills and CLI tools for coordinating coding agents in OpenCode and Claude Code through [Herdr](https://herdr.dev/).

<img width="1600" height="689" alt="image" src="https://github.com/user-attachments/assets/800655fa-8603-47d5-9f2e-6cf0b56dcad6" />

> Inspired by Matrix: an Operator loads programs, guides missions, and keeps the crew in the field connected.

Operator is based on [Matt Pocock's agent skills and workflow](https://github.com/mattpocock/skills).
His skills guide the work from clarifying a goal and writing a spec through tickets, implementation, and review.
Operator builds on that workflow by coordinating the agents, worktrees, and recorded decisions that carry the work between those steps.

A SuperAgent coordinates WorkerAgents.
The CLI keeps the workflow state and tells each agent its next action.
One installed release serves every project on the device, and Operator keeps its settings and state on the device, not in a checkout.
`CONTEXT.md` defines the terms, and `docs/adr/` records the decisions.

## How the workflow runs

The SuperAgent registers a work source, which is a plan of assignments from the tracker.
Each assignment completes through a pull request or through a report.
The CLI keeps the state of each source and assignment, and `operator next` returns the next action for each one.

This diagram shows the assignment states of `src/modules/work-sources/assignment-machine.ts`, with the transitions that `report-machine.ts`, `source-machine.ts`, dispatch, and the PR commands record.

```mermaid
stateDiagram-v2
    state "pr-open" as pr_open

    [*] --> ready: source register
    [*] --> ready: report accept --promote, worker stopped
    [*] --> running: report accept --promote, worker kept
    ready --> running: dispatch
    running --> pr_open: pr associate
    pr_open --> merged: pr merge
    running --> reported: report submit
    reported --> completed: report accept, with or without --promote
    reported --> running: report return, then report resume
    reported --> running: dispatch, after a return whose worker stopped
    ready --> abandoned: source reset
    running --> abandoned: source reset
    pr_open --> abandoned: source reset
    reported --> abandoned: source reset
    merged --> [*]
    completed --> [*]
    abandoned --> [*]
```

- `ready`: the assignment waits for its dependencies.
  A pull request dependency must be open or merged, and a report dependency must be completed.
  A PR assignment also waits while more than one of its parent PRs is open.
  When the plan sets `maxRunning`, ready work also waits while that many of its assignments have a starting or live worker.
  `dispatch` refuses it then.
- `running`: a WorkerAgent works in its own Herdr pane or worktree.
- `pr-open`: the owner carries the PR to its merge.
  With internal review on, the default, the PR starts as a draft and goes through the internal review below first.
  With internal review off, the implementer opens a ready PR and owns it to the merge.
  The owner answers review feedback and failing checks, then merges with `pr merge`.
- `reported`: the SuperAgent accepts the report, returns it with a follow-up, or promotes it.
  After a return, the worker resumes, or a dispatch replaces a worker that stopped.
  A promotion accepts the report and adds a new PR assignment that takes over the report's worktree.
  When the report's worker still runs, the PR assignment starts `running` with that worker, and the worker gets its new brief by steering message.
  Otherwise the PR assignment starts `ready`, and a dispatch reopens the worktree.
- `merged` and `completed`: the work is done, and the CLI removes the branch, pane, and worktree.
  A promoted report keeps its pane and worktree for the PR assignment.
  Work that did not land stays until you decide.
- `abandoned`: you ended the source with `source reset` before the work was done.

A source is `open` until each assignment is merged or completed, and then it is `finished`.
`source prune` deletes an ended source 14 days after its end.

### Internal review

With internal review on, `pr associate` of a draft PR records an internal review.
It refuses a PR that is not a draft, and a worktree with changes that are not pushed.
This diagram shows `src/modules/pull-requests/internal-review-machine.ts`, with the handoff states that `src/modules/device-state/internal-reviews.ts` records.

```mermaid
stateDiagram-v2
    [*] --> reviewing: pr associate, draft PR
    state reviewing {
        [*] --> pending
        pending --> done: reviewer launch reserved
        pending --> failed: handoff step fails
        failed --> pending: dispatch
        failed --> done: dispatch of the reviewer
        done --> done: pr round, at most two
    }
    reviewing --> ready: pr ready
    reviewing --> skipped: internal-review skip
    ready --> [*]
    skipped --> [*]
```

- `pending`: the CLI closes the implementer's pane and starts a fresh WorkerAgent in the same worktree.
  `next` shows a running handoff as `wait` with `kind_handoff`.
- `failed` or stopped: `next` shows `replace_worker` with `handoff_failed`.
  The SuperAgent dispatches the assignment from the controlling checkout to resume the recorded next kind.
- `done`: the reviewer checks the draft against the issue, the standards, and the skills that the brief names.
  Each `pr round` records the findings at the worktree head, and leaves the handoff state `done`.
  A second round needs a newer head, and there is no third round.
  An applied blocker from round 1 requires round 2.
- `ready`: `pr ready` checks a disposition for each finding, posts one summary comment, and marks the PR ready.
  The reviewer then owns the PR to its merge.
- `skipped`: on your instruction, the SuperAgent ends a running review with `internal-review skip`, which marks the PR ready with no comment.

The implementer runs no PR command after the handoff.

The detached continuation keeps the outgoing caller's identity. It does not become the source's supervisor.
The CLI checks its exact pending handoff, PID, fresh lease, outgoing launch, pane, and socket before continuing.
It checks the same identity again at claim, lease renewal, pane closure, and launch reservation.
Reservation consumes the handoff with the new launch and makes no supervisor write.

PID publication has a one-second, read-only wait. If publication does not arrive, the continuation refuses without claiming another process's hold.
This bound does not guarantee scheduler progress; the supervisor recovers a stopped handoff with ordinary dispatch.
An internal flag alone grants no dispatch authority or fallback, even to a supervisor's internal-continuation request.
The existing trusted-device PID, lease, and pane records do not authenticate process incarnation or the exact worker session.
Strict pane matching can refuse safely on a stale-pane host topology. External pane closure is not atomic with SQLite, and lease renewal is not fencing against arbitrary process suspension.
`pr merge` refuses until the internal review is `ready` or `skipped`.

## Install

Bun 1.4.0 or later is required, except with Nix, which brings its own Bun.
Install Operator one time for the device, in one of these three ways.
To move to a new release, follow [Update Operator](https://github.com/fveracoechea/operator/blob/main/docs/update.md).

### JSR with Bun

Add the JSR scope to Bun's global config.
When `XDG_CONFIG_HOME` is set, Bun reads `$XDG_CONFIG_HOME/.bunfig.toml` and ignores `~/.bunfig.toml`.
Otherwise, Bun reads `~/.bunfig.toml`.

```toml
[install.scopes]
"@jsr" = "https://npm.jsr.io"
```

Install the latest release, then register the project and write the `operator` command:

```sh
bun add -g --exact "@fveracoechea/operator@npm:@jsr/fveracoechea__operator@latest"
OPERATOR_PACKAGE="$(bun pm ls -g | head -n 1 | sed 's/ node_modules (.*//')/node_modules/@fveracoechea/operator"
bun "$OPERATOR_PACKAGE/cli.js" project register --json
bun "$OPERATOR_PACKAGE/cli.js" install launcher --json
operator --version --json
```

Keep `--exact`, because `install launcher` refuses a release without an exact version, and `ready` reports one.

### Repository source

```sh
bun add -g "git+https://github.com/fveracoechea/operator.git#<full-commit>"
operator project register --json
operator --version --json
```

Use the full 40-character commit, so that a Bun update cannot move the installation.

### Nix flake

The flake supports `x86_64-linux` and `aarch64-darwin` and includes the pinned Bun runtime.
Operator exports a package, not a Home Manager module.
Pin a published release tag in your `flake.nix`:

```nix
inputs.operator.url = "github:fveracoechea/operator/v<version>";
```

Replace `<version>` with a version from [GitHub Releases](https://github.com/fveracoechea/operator/releases).
The `v2.2.1` flake has an incomplete dependency cache and does not build, so use a later release.

Add the package, skill links, and host hooks to your Home Manager configuration.
For standalone Home Manager, set `extraSpecialArgs = { inherit inputs; };` in `homeManagerConfiguration`.
For NixOS or nix-darwin, set `home-manager.extraSpecialArgs = { inherit inputs; };`.
This makes `inputs` available to the module.
Keep only the host configuration that you use:

```nix
{ config, inputs, lib, pkgs, ... }:

let
  operator = inputs.operator.packages.${pkgs.stdenv.hostPlatform.system}.default;
  ownedSkills = lib.genAttrs operator.skills (name: "${operator}/share/skills/operator/${name}");
in
{
  home.packages = [ operator ];

  programs.claude-code = {
    enable = true;
    configDir = "${config.home.homeDirectory}/.claude";
    skills = ownedSkills;
    settings.hooks = {
      PreToolUse = [{
        matcher = "Bash";
        hooks = [{
          type = "command";
          "if" = "Bash(git *)";
          command = "operator claude hook";
        }];
      }];
      Stop = [{
        hooks = [{
          type = "command";
          command = "operator claude hook";
        }];
      }];
    };
  };

  programs.opencode = {
    enable = true;
    skills = ownedSkills;
  };
  xdg.configFile."opencode/plugins/operator.ts".source = "${operator}/share/opencode/plugins/operator.ts";
}
```

Update the lock file from your configuration's directory:

```sh
nix flake update operator
```

Rebuild and activate your Home Manager, NixOS, or nix-darwin configuration.
Then register the project from its main checkout and check the installed package.
Use only the flags for the hosts that you configured:

```sh
operator project register --json
operator --version --json
operator install --opencode --claude --check --json
```

Nix owns the Operator skill links, Claude Code hooks, and OpenCode plugin.
Operator checks them but does not write or repair them.
Run `operator install --opencode --claude --json` without `--check` to install the upstream skills.
Those upstream skills are not part of the Nix package.
Use [Update Operator](docs/update.md#nix-flake) for later releases.

### PATH

Put `bun` and the folder that `bun pm bin -g` reports on `PATH`, for your shells and for Herdr.
With Nix, the profile's bin folder is enough.
`operator ready --json` reports a missing or wrong `operator` command.

## First run

Run the first registration from the main checkout of a project with a GitHub remote:

```sh
operator project register --json
operator --help
operator --version --json
```

Every other command refuses with `state_missing` until you register a project.

## Commands

`operator --help` lists every command, and every command takes `--json`.

### Device and projects

```sh
operator config show --json
operator config plan --set superAgent.host=opencode --json
operator config apply --set superAgent.host=opencode --plan <plan-id> --json
operator config recover --json
operator config resolve --role workerAgent --json
operator host models --host claude-code --json
operator project show --json
operator project list --json
operator project move --json
operator project remove owner/repository --person-instructed --json
```

Settings are in `$XDG_CONFIG_HOME/operator/config.json`, and state is in `$XDG_STATE_HOME/operator/`.
The hosts are `opencode` and `claude-code`.
WorkerAgents use the SuperAgent's host and model, unless a profile under `profiles.<name>` sets others.
`project remove` deletes Operator records only, never checkouts, branches, or worktrees.

### Skills and readiness

```sh
operator install --opencode --claude --json
operator install --opencode --claude --check --json
operator ready --json
```

Run `install` after each install or update of Operator, for each host that settings select.
`install` copies the Operator skills into the host folders, and it does not overwrite your edits.
Then it installs these upstream skills globally with the pinned `skills` installer, at the current commit of each repository:

- Matt Pocock's skills from the `skills/productivity` and `skills/engineering` folders of `mattpocock/skills`, except names that Operator owns.
- `unslop` from `cursor/plugins`.
- `show-me` from `humanlayer/skills`.

The upstream installer can replace your edits to those skills.
`install --claude` also adds the commit hook to `~/.claude/settings.json`, as a `PreToolUse` group and a `Stop` group that both run `operator claude hook`.
Before a git command, the hook blocks a commit whose message has a Co-Authored-By trailer.
At the end of a SuperAgent's turn, the hook is the turn-end guard: while the sources that its session supervises have running work and no `next --wait` from that session runs, it blocks the end once and tells the SuperAgent to start the wait in the background. Missing or unusable device state lets the turn end.
When that file is a link, for example into a dotfiles repository, `install` changes nothing and reports `claude_settings_external` with the hook groups to add.
`install --opencode` also writes Operator's OpenCode plugin to `~/.config/opencode/plugins/operator.ts`, which runs `operator opencode hook` with the same two guards.
It refuses a shell `git commit` with a Co-Authored-By trailer, and when a SuperAgent's session goes idle under the same condition, it continues the session once with the same reason. Another continuation needs a person prompt or a background wait that ran in between.
A wait that the session already runs in the background skips the check. The guard asks for the idle session itself, so a subagent's session or another session in the same pane gets no reason.
A linked plugin file or folder, or a file there that Operator did not write, stays unchanged, and `install` reports `opencode_plugin_external` with the file to link. A Nix install ships the plugin at `share/opencode/plugins/operator.ts` for the consumer to link.
`ready` requires the Operator skills and Matt's `code-review` skill.
`install --check` checks the Operator skills, with `--claude` the commit hook, and with `--opencode` the plugin. It reports `skills_missing` for skills that are not installed, `skill_copy_conflict` for skills with different contents, `claude_hook_missing` when Claude Code settings do not run the commit hook on both events, and `opencode_plugin_missing` or `opencode_plugin_outdated` when the plugin file is absent or carries an older version marker.
`ready` checks `gh` and its login, `herdr`, the `operator` command, the host, the skills, and the commit hook on Claude Code or the plugin on OpenCode.

### Assignments and dispatch

```sh
operator source register --file /absolute/path/assignments.json --json
operator source show --source <source-id> --json
operator next --json
operator next --wait --timeout 300 --json
operator herdr install --json
operator dispatch --source <source-id> --assignment <key> --json
operator dispatch --kind research --brief /absolute/path/task.md [--intent-file /absolute/path/intent.txt] [--profile <name>] [--tracker-key <key>] --json
operator ask --file /absolute/path/question.txt [--profile <name>] --json
operator source take-over --source <source-id> --person-instructed --json
operator source reset --source <source-id> --person-instructed --json
operator source prune --json
```

The SuperAgent reads the tracker and gives the CLI a JSON plan.
`next` returns the next actions and writes nothing.
`next --wait` blocks until the next actions other than waits change, or until its timeout, and then returns the normal next answer.
The SuperAgent runs it in the background, so worker events reach it without text typed into its pane.
`herdr install` links the Herdr plugin that prepares each worktree and records worker activity.
`dispatch` starts a ready assignment in a Herdr pane or worktree.
`dispatch --kind --brief` creates a one-off source with one planned assignment and starts its worker.
Use `--brief -` to read the task from stdin.
Optional `--intent-file <path|->` reads the person's words as plain text.
The task and intent cannot both select stdin. Supply a file for at least one field.
The kind fixes completion and supplies resources and a default profile.
Without `--tracker-key`, the source gets `<kind>:<8 hex digits>`.
One-off sources use the same next actions, report promotion, reset, and prune as registered plans.
They never gain another planned assignment.
`ask` is the `answer` preset, with pane resources and a CLI-written question brief.
Use `ask --file -` with a quoted heredoc to preserve literal prose (ADR-0032):

```sh
operator ask --file - --json <<'QUESTION'
Why does `next --wait` return this row? Keep $HOME literal.
QUESTION
```

The agent session that dispatches a source's work or waits for that source supervises it, together with its Herdr pane. Operator reads the session from `OPENCODE_SESSION_ID` or `CLAUDE_CODE_SESSION_ID`.
A coordination command for that source from another session refuses with `source_supervised_elsewhere` and names the supervising session and pane. `source take-over` moves supervision to the calling session on the person's instruction.
OpenCode WorkerAgents use the full TUI, with the `worker` agent and selected model and effort set before attachment.
Configure a primary agent named `worker` in OpenCode; Operator does not install or modify that agent's permissions.
If OpenCode does not confirm the `worker` selection, dispatch fails instead of using the default agent.
Herdr's OpenCode terminal integration must be enabled to report their activity; Mini does not load it.

### Reports

```sh
operator report submit --file <report.md> --json
operator report resume --json
operator report accept --source <source-id> --assignment <key> --json
operator report accept --source <source-id> --assignment <key> --promote <promotion.json> --json
operator report return --source <source-id> --assignment <key> --file <follow-up.md> --json
```

The WorkerAgent submits and resumes from its own pane.
Only the SuperAgent accepts or returns a report.
Reports use `## Conclusion`, `## Evidence`, `## Unresolved points`, `## Supporting files`, `## Human answers`, and `## SuperAgent decisions`.
The conclusion is prose; other sections use `- ` bullets, or `- None.` when empty.
Decision bullets read `<question> Answer: <answer>`; supporting files use absolute paths.
Questions, answers, messages, replies, and report submissions accept `--file -` for stdin or a file path.
Use a quoted heredoc with stdin to preserve shell punctuation, as ADR-0032 requires.
`--promote` accepts a report whose worker had a worktree, and adds the PR assignment that the file describes.

### Worker questions

```sh
operator question ask --key <key> --file <question.md> --json
operator question wait --key <key> --timeout 300 --json
operator question withdraw --key <key> --json
operator question escalate --source <source-id> --assignment <key> --key <question> --json
operator question answer --source <source-id> --assignment <key> --key <question> --by super-agent --file <answer.md> --json
```

The WorkerAgent asks, waits for the answer, and withdraws from its own pane.
`next` shows an open question as `answer_question`, and a question that the SuperAgent escalates to the person as `person_decision`.
Only the SuperAgent answers, and `--by person` records an answer that the person gave.
Questions and answers are plain text, not JSON envelopes.

### Steering messages

```sh
operator message send --source <source-id> --assignment <key> --key <message> --file <message.md> --json
operator message ring --source <source-id> --assignment <key> --key <message> --json
operator message close --source <source-id> --assignment <key> --key <message> --json
operator message read --key <message> --json
operator message ack --key <message> [--file <reply.md>] --json
```

Messages and optional replies are plain text, not JSON envelopes.
The SuperAgent records a keyed message for a running WorkerAgent, and the CLI types a fixed doorbell line that names the key into the worker's pane.
The WorkerAgent reads and acknowledges the message from its own pane, with an optional reply.
`next` shows a reply as `read_reply` until the SuperAgent closes the message, and a message whose doorbell failed or that stays pending for 15 minutes as `worker_attention`.
An answer to a worker question reaches the worker as the message `answer:<question>`, and `question wait` acknowledges it.

### Obligations

```sh
operator obligation add --source <source-id> --key <key> --kind <kind> [--reference <ref>] --file <summary.txt> --json
operator obligation close --source <source-id> --key <key> --json
operator obligation list --source <source-id> --json
```

The SuperAgent records what it owes the person in a source: a PR to share, a review reply, a merge hold, a standing rule, or a person's decision that waits to be recorded.
`next` lists each open obligation in the source's `owed` field until the SuperAgent closes it.
An obligation is not an action, so adding or closing one wakes no coordination wait.

Pass identifiers as flags and the summary as plain text from a file or stdin.
For example:

```sh
operator obligation add --source <source-id> --key share-12 --kind pr-share --reference https://github.com/example/one/pull/12 --file - --json <<'EOF'
Share PR #12 in the team review thread.
EOF
```

`--reference` is optional. The summary must contain 1 to 2000 characters after trimming.
JSON documents are refused, including JSON strings and scalar values.
Bracket-prefixed prose such as `[Hold] Wait for approval.` remains plain text.

### Pull requests

```sh
operator pr associate --json
operator pr round --file <findings.md> --json
operator pr wait --timeout 300 --json
operator pr ready --file <summary.md> --note <reviewer-note.md> --json
operator pr merge --json
operator internal-review skip --source <source-id> --assignment <key> --person-instructed --json
operator cleanup --source <source-id> --assignment <key> --json
```

The WorkerAgent runs the `pr` commands in its worktree.
`pr wait` reports new feedback, failing checks, and a merged parent pull request.
`pr merge` merges only a ready PR whose base is the default branch.
It also needs an approving review, passing checks, no unresolved thread, a finished parent relay, the worktree at the PR head, and recorded `pr_ready`.
It asks GitHub for the merge in the background, then records it only after GitHub shows the PR merged.
`pr round` records the findings of one internal review round at the worktree head, and refuses a third round or a second round at the first round's head.
Both review commands read markdown from a file or stdin and refuse JSON.
A round with no findings uses the heading without bullets:

```sh
operator pr round --file - --json <<'EOF'
## Findings
EOF
```

Each finding is one bullet: `- <severity>, <axis>, <location>: <claim>`.
Severity is `blocker` or `nice-to-have`. Axis is `Spec`, `Standards`, or `Skills`.
Ready input has a prose overview and one disposition per recorded finding.
With no findings, keep the dispositions heading without bullets:

```sh
operator pr ready --file - --json <<'EOF'
## Overview
The review found no issues.

## Dispositions
EOF
```

Disposition bullets read `- 1.1 applied` or `- 1.1 declined: <reason>`.
The first number selects the round; the second selects its finding, starting at 1.
Malformed bullets report their line number and the next command. A refusal changes nothing.
`pr ready` ends the review launch and starts fresh `pr-feedback` in the same worktree.
Ready-PR association with internal review off does the same.
Both transitions require a clean worktree at the pushed PR head.
The first feedback brief and replacements include recorded rounds, dispositions, decline reasons, the ready head, and the summary link.
Optional `--note <file|->` copies up to 60 lines into assignment device files and quotes them in feedback briefs.
Review briefs receive no note.
Only one of `--file` and `--note` can select stdin.
`internal-review skip --person-instructed` records permission only.
The live reviewer then runs `operator pr ready --json` without rounds or a summary comment.

The SuperAgent runs `dispatch` from the controlling checkout when `next` shows a failed kind handoff.
Internal review is on by default, and `review.internal` set to `false` in settings turns it off for the device.
A plan's `internalReview` field sets it for all its assignments, and a PR assignment's `internalReview` field sets it for that assignment.
The most specific value wins.
A plan's or an assignment's optional `intent` holds the person's own words, and the brief shows it as the acceptance criteria. The assignment's value wins.

### Recover a missing promoted internal review

Older live report promotions could inherit the report launch's null review setting and associate a draft without its required internal review.
New promotions resolve assignment, plan, and device policy before handing over the worker.
That forward fix does not repair an already-associated PR, and repeated association or `handoff` cannot create its missing review.

On the person's explicit instruction, run this recovery from the controlling checkout using the retained source, assignment, implementer launch, PR, and full pushed head:

```sh
operator internal-review recover --source <source-id> --assignment <key> --launch <implementer-launch-id> --pr <number> --head <40-character-head> --person-instructed --json
```

The flag attests the person's instruction for that exact recovery, not permission inferred by an agent.
Recovery accepts only the known live-promotion defect with its original running owner and matching branch, worktree, and existing PR association.
The promotion override, or the retained plan without that override, must explicitly require internal review.
A device-only default cannot prove the historical policy, so recovery refuses that ambiguous case.
The PR must remain the only open PR on its branch, remain a draft, and match the authorized head in a clean worktree.
That GitHub head proves that the worktree commit was pushed.

One transaction rechecks the retained ownership and history, records the authorization receipt, and creates the missing reviewing record with a pending handoff.
The result's `data.recovery` contains the retained provenance and authorization time.
The receipt is the immutable body of a new pending system steering message, `internal-review:recovery`, under ADR-0033.
Ordinary `message send` cannot use that reserved system key.
The reviewer can read and acknowledge it with the normal message commands; acknowledgement and closure preserve the receipt.
Recovery needs no schema migration, so an existing open assignment does not block startup through the device's idle migration guard.
An older installation can still have other pending schema migrations, which require their ordinary supported upgrade conditions before this command can run.
Recovery authorization does not waive those conditions or authorize a source reset.
An exact retry returns the same receipt without another handoff, including after the reviewer starts.
Changed provenance, ended sources or reviews, incompatible owners, existing unrelated review history, and ambiguous associations refuse without writes.
Launch snapshots and existing review requests remain unchanged.
No review rounds, approval, or ready metadata are fabricated.
The ordinary fresh-reviewer handoff and genuine GitHub approval remain required.
If the handoff stops, use `operator dispatch --source <source-id> --assignment <key> --json` after inspecting its recorded failure.
Recovered handoffs recheck the authorization, active review, draft, branch, clean worktree, and exact pushed head before closing the implementer.

### Reviews

```sh
operator review add <pr-url> --json
operator review start <pr-url> --json
operator review wait --json
operator review next --json
operator review post <pr-url> --json
operator review skip <pr-url> --json
operator review cleanup <pr-url> --json
```

A reviewer agent writes a draft with the `pr-review` skill, and only `review post` posts it.
With `review.assignments` set to `true`, each PR assignment also gets this reviewer after its PR is open.
It posts a comment and is separate from internal review.
With internal review on, it is queued when the internal review ends, so it reviews the ready PR.
`review add` applies the device's `review.repos` and `review.authors` policy.
On request, the SuperAgent searches GitHub for requested reviews or reads Slack with its own tools.
An optional `--slack-thread <permalink>` on `review add` keeps the thread link on each review row.
After a post, the SuperAgent replies once in that thread with one short status line and the review link, with no draft.
Operator schedules no Slack reads and records no reply acknowledgement or retry.
