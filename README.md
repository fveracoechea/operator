# Operator

Personal skills and CLI tools for coordinating coding agents in OpenCode and Claude Code through [Herdr](https://herdr.dev/).

The name comes from *The Matrix*: the crew member who loads programs, guides missions, and keeps the people in the field connected. Here, the Operator is your primary agent. You give it direction; it coordinates a crew of sub-agents.

<img width="1600" height="689" alt="image" src="https://github.com/user-attachments/assets/800655fa-8603-47d5-9f2e-6cf0b56dcad6" />


## Status

Every step of the first orchestration workflow works end to end: project setup, release selection and updates, readiness, the live probe, crew state, dispatch, questions, review, rework, tracker completion, cleanup, and the coordination loop.
The repository also holds the release build, the Operator-owned JSR client, the Changesets and GitHub Actions workflows, and smoke tests of both delivery paths.

Nothing is published yet.
The release workflow publishes a version after its version pull request merges.

## How it works

1. You work with the Operator to clarify a goal and choose the work to delegate.
2. The Operator registers the work and assigns each item to a crew member, called an Operative. Each Operative runs in its own Git worktree that Herdr manages.
3. Operatives use skills such as `implement`, `research`, `improve-codebase-architecture`, and `grilling` to do their work.
4. An Operative that cannot continue asks the Operator. The Operator answers from recorded decisions, and brings the questions that need your judgment to you.
5. A separate reviewer checks each result on the Standards and Spec axes before the Operator presents it for acceptance.
6. After you accept a result, the Operator closes the crew agent and removes its worktree. Cleanup that is not complete stays visible until it is done or you defer it.

You can talk to an Operative directly, but the main workflow goes through the Operator.

Herdr supplies the terminal and agent control.
Operator adds the coordination rules, the skills, and the CLI operations that Herdr does not have.

## Requirements

| Tool | Why |
| --- | --- |
| [Bun](https://bun.com) 1.4.0 or later | Runs the CLI. The CLI refuses an earlier Bun. |
| Git | Holds the project and each Operative worktree. |
| [Herdr](https://herdr.dev/) | Creates worktrees, launches agents, and reads their panes. |
| GitHub CLI (`gh`) | Reads and writes the tracker. GitHub is the only tracker this release supports. |
| Claude Code, OpenCode, or both | The agent hosts for the Operator and the crew. |

## Quick start

Each command that changes the project first shows a plan, and changes nothing until you approve that exact plan.
Add `--json` to any command for the versioned machine result.

```sh
# 1. Install the Operator-owned skills for one or more agent targets.
operator install --claude

# 2. Configure the project. Review the plan, then apply it.
operator setup plan --claude --json
operator setup apply --claude --approved-plan <planId> --json

# 3. Select the exact release the project coordinates with.
operator update plan --claude --commit <full-commit> --json
operator update apply --claude --commit <full-commit> --approved-update <updateId> --json

# 4. Check readiness, then prove the live checks with an approved probe.
operator setup readiness --claude --operator-host claude-code --json
operator setup probe plan --claude --operator-host claude-code --crew-host opencode --json
operator setup probe apply --claude --operator-host claude-code --crew-host opencode --approved-probe <probeId> --json

# 5. Take the crew, register work, and ask what to do next.
operator crew own --request <id> --owner-label <label> --json
operator work register --request <id> --owner-token <token> --input work.json --json
operator crew next --claude --operator-host claude-code --json
```

From there, `operator crew next` names each command to run, the record it acts on, and the revision to state.
The Operator-owned skill runs that loop for you.

## Contents

- [CLI conventions](#cli-conventions)
- [Project installation and setup](#project-installation-and-setup)
- [Release and updates](#release-and-updates)
- [Project readiness](#project-readiness)
- [The live probe](#the-live-probe)
- [Crew state and the frontier](#crew-state-and-the-frontier)
- [Operative dispatch and recovery](#operative-dispatch-and-recovery)
- [Questions, answers, and approvals](#questions-answers-and-approvals)
- [Reviewed results and acceptance](#reviewed-results-and-acceptance)
- [Rework, limits, and invalidated results](#rework-limits-and-invalidated-results)
- [Tracker completion and recovery](#tracker-completion-and-recovery)
- [Cleanup](#cleanup)
- [Coordination and recovery](#coordination-and-recovery)
- [Development](#development)

## CLI conventions

Use `bun cli.ts --version` for human output or `bun cli.ts --version --json` for the versioned machine result.
The package also exports `main(args)` from `@fveracoechea/operator/cli`.

The exit meanings are the same for every command.

| Exit | Meaning |
| ---: | --- |
| 0 | Completed |
| 1 | Definite failure |
| 2 | Invalid request or input |
| 3 | Missing condition or approval |
| 4 | State or ownership conflict |
| 5 | Uncertain external effect |
| 6 | Recorded operation still pending |

Every mutation carries a request identity, `--request <id>`.
A repeat under the same identity returns the recorded result of a mutation that changed state, with no new effect, and `repeated` in the result says so.
A refused mutation records nothing, so the CLI checks a repeat of it again against the current state.
After an identity records an outcome, the CLI refuses the same identity with different input.

A request that takes a JSON file with `--input` also reads standard input when you pass `-`.

## Project installation and setup

Install the Operator-owned skills into a project.
You must name at least one target, and the CLI never guesses a target from the agents it finds.

```sh
operator install --opencode
operator install --claude
operator install --opencode --claude
```

The command adopts a copy that already matches this release, and writes nothing for it.
A copy that someone changed is a conflict, and the command then writes nothing.

Setup inspects first and writes nothing until you approve the same plan.

```sh
operator setup plan --claude --json
operator setup apply --claude --approved-plan <planId> --json
```

The plan identifier covers the selected targets and the exact content of every proposed change.
A changed project or a changed target makes a new identifier, and the CLI refuses the old approval.
An unchanged rerun writes nothing.

Setup owns these files:

- `.operator/config.json` and `.operator/config.schema.json`.
- One marked `/.operator/` block in `.gitignore`.
- One marked Operator section in `AGENTS.md`.
- An `@AGENTS.md` import in `CLAUDE.md`.

Setup never commits, never changes the Git index, and never installs machine-wide software.
It records each completed write and the previous contents of the file.

```sh
operator setup rollback --json
```

Rollback restores only the files that still hold what setup wrote.
It keeps a file that changed after setup wrote it, and reports that file as a conflict.

## Release and updates

One release is one matched version of the CLI code and the Operator-owned skills.
It reaches a project by one of two paths, both from the same commit, and neither path runs a build when you retrieve it.

```sh
# The source path, as a convenience and pinned to one exact commit.
bunx github:fveracoechea/operator <operation>
bunx "github:fveracoechea/operator#<full-commit>" <operation>
```

```sh
# The registry path installs first, isolated from the application, then executes.
cd .operator/install && bun install --frozen-lockfile
bun --no-install -e 'const { main } = await import(Bun.pathToFileURL(Bun.resolveSync("@fveracoechea/operator/cli", `${process.cwd()}/.operator/install`)).href); await main(Bun.argv.slice(1))' -- <operation>
```

The registry path keeps its own manifest, lock data, and dependencies under `.operator/install/`, so Operator never shares a dependency with the application it serves.
The launcher resolves the package from that installation and keeps the project as the working directory.

Coordinated work runs one known release, so a project records the exact release it coordinates with.

```sh
operator update plan --claude --commit <full-commit> --json
operator update apply --claude --commit <full-commit> --approved-update <updateId> --json
```

A registry installation also names its exact published version with `--delivery jsr --package-version <version>`.
The update identifier covers the release it moves to, the skills it would write, the recorded formats it would migrate, and the records it would back up.

An update writes nothing while the crew still has work in flight.
It copies every durable record aside and reads each copy back before a recorded format moves.
If a migration cannot finish, the update puts those records back exactly as they were.
It writes the CLI selection and the owned skills together, so a project never runs one release of the code against the workflow instructions of another.

Until a project selects a release, the `operator-installation` check is unverified and the project is never ready.
A missing installation, a mismatched one, and missing lock data are blockers.
Operator never answers them with another installation.

Crew state records the release that wrote it.
The CLI refuses a state file from an earlier release with `state_version_outdated` until an approved update migrates it.
It refuses a file from a newer release with `state_version_unsupported`.

### Publishing

Publication is automatic, and the CLI does not carry it.

1. Each change that reaches a consumer carries a changeset.
2. On a push to `main`, Changesets opens or updates the version pull request.
3. Merging that pull request is the decision to release that version.
4. On the merged commit, the release workflow runs the quality gate and the release smoke. The publish job starts only after both pass.
5. The publish job creates the tag and the GitHub release, and publishes the artifact to JSR.

A later push that carries the same version publishes nothing, because both paths already hold it.

The release tooling runs outside the CLI.

```sh
bun scripts/release.ts build   --out dist --commit <full-commit>
bun scripts/release.ts plan    --out dist --commit <full-commit>
bun scripts/release.ts publish --out dist --commit <full-commit>
```

The artifact holds runnable ESM, the public declarations, the complete owned-skill directories, and the generated configuration schema.
Its identity covers every byte it holds.
The release identity binds the delivery record to that version, that merged commit, and that content.

The plan refuses these conditions:

- A commit that is not merged into the release branch.
- A tag that already names another commit whose release is not complete.
- A version that the registry already holds, with no record of this release.

A published tag never moves and a published version is never replaced, so changed content is a new version.

A partial publication records what it delivered.
Run the failed publish job again, and it sends only the path that is still missing.
The job then exits 6, which is the pending exit meaning, not a failure to repair by hand.

The JSR path uses the official `jsr` client, pinned in the development dependencies.
It runs on a staged copy of the artifact, and it authenticates with the short-lived credential that GitHub issues to the job.
No publishing token is stored.
Deno runs only inside that client as a publishing tool, and Operator never runs on Deno.
See [ADR 0013](docs/adr/0013-one-release-is-one-matched-version-delivered-twice.md).

## Project readiness

Configured is not ready.
Configured means the approved setup plan is complete and the selected files and settings validate.
Ready means the required checks passed for the exact selection and inputs you are about to launch.

```sh
operator setup readiness --claude --operator-host claude-code --json
```

The command reads the machine and the project and writes nothing.
It reports one of three states beside a separate `configured` field.

| State | Meaning |
| --- | --- |
| `blocked` | A required check failed. The blockers name the reason, the paths, and the next action. |
| `unverified` | Every required static check passed, and required live evidence is missing or stale. |
| `ready` | Every required check passed against the current inputs. |

Static checks observe these items:

- The selected hosts, Bun, Git, Herdr, and the GitHub CLI.
- The instruction files and the discoverable skill contents.
- The Operator release, the selected installation, and its lock data.
- The project settings.

Static checks never prove host termination, the native review sub-agents, or provider compatibility.
Those need a live probe.

The CLI resolves each selection field on its own, from a session override, then `.operator/config.json`, then the host default.
A missing Crew host follows the Operator host, and a missing model stays with the selected host default.
Operator never substitutes an unavailable host or model, and it never guesses a host that nothing names.

## The live probe

A live probe launches agents, spends provider tokens, and writes to a tracker, so it needs its own approval.

```sh
operator setup probe plan --claude --operator-host claude-code --crew-host opencode --json
operator setup probe apply --claude --operator-host claude-code --crew-host opencode --approved-probe <probeId> --json
```

The plan shows what the run would use, before anything launches.

- The exact hosts and models.
- What each provider is asked to do, and what it bills.
- The credentials each host and the fixture need.
- What the fixture must already hold.
- The temporary resources the probe makes.
- The expected cost, as the number of synthetic prompts each host sends.
- Each check, and the claims it feeds.
- What cleanup removes, and what it leaves.

A change to the project, the selection, or what the plan declares makes a new `probeId`, and the CLI refuses the old approval.

The probe runs on resources it creates for itself.
It builds a synthetic repository under `.operator/local/probe/`, asks Herdr for one managed worktree of it, launches one agent on each selected host, and writes to the tracker fixture you name in configuration.
The synthetic repository holds a copy of your instruction files and the skills this release installs, so the loading check reads your own contents back.
It reaches no project issue, no Operative worktree, no branch, no remote, and no release.

```json
{ "probe": { "githubFixture": { "repository": "you/probe-fixture", "issue": 7, "mapIssue": 7 } } }
```

If a project names no fixture, every tracker check stays skipped.
That project is then never ready and never releasable, and the plan says so before anything runs.

Probe cleanup removes the scratch repositories that earlier runs left behind.
It has its own approval, bound to the directories it would remove.

```sh
operator setup probe cleanup --json
operator setup probe cleanup --approved-cleanup <cleanupId> --json
```

It removes nothing else, and the recorded observations stay, so every failed attempt outlives its resources.

Operator records live results in `.operator/local/readiness.json` as a list of attempts, and only appends to it.
Each observation holds its state, the versions and inputs it ran against, its outputs, its evidence, and the state of what it left behind.
The most recent attempt that ran a check gives the result for that check.
If no attempt ran a check, the earlier result stays.
A changed input makes its own record stale and keeps unrelated records valid.
A check that failed, and a check the probe attempted and could not run, both hold back the claims they feed.
See [ADR 0002](docs/adr/0002-readiness-is-derived-and-only-live-evidence-is-recorded.md) and [ADR 0012](docs/adr/0012-a-live-probe-proves-itself-on-its-own-resources.md).

## Crew state and the frontier

One Operator owns a crew at a time.
Ownership creates the crew state, which is one SQLite database in `.operator/local/`.

```sh
operator crew own --request <id> --owner-label <label> --json
operator crew own --request <id> --owner-label <label> --takeover --ownership-revision <n> --json
```

The result carries the owner token that every later mutation must present.
A takeover names the ownership revision it inspected, so two Operators cannot both believe they won.
It invalidates the former token, so a stale Operator session cannot change crew state.

You register work from an approved specification, a ready ticket, or a wayfinder map.

```sh
operator work register --request <id> --owner-token <token> --input work.json --json
```

Registration records each item with these fields:

- The source revision.
- The approved scope and the acceptance requirements.
- The permissions and the fixed inputs.
- The dependencies and the planning boundary.

When you register the same item twice, the CLI names the existing assignment and does not create a second one.
The CLI refuses a dependency cycle before it dispatches anything.
It also refuses a re-registration that states different dependencies.

```sh
operator work frontier --json
operator work claim --request <id> --owner-token <token> --assignment <id> --revision <n> --json
```

The frontier reports what the crew may start now and why the rest waits.
It writes nothing.
A claim recomputes the same frontier, so it can never take work the frontier withheld.
When two claims race, one caller gets the assignment, and the other names the attempt that already holds it.

The crew limit is three active agents by default.
Set it with `crew.maxActiveAgents` in `.operator/config.json`.
A limit of two or more keeps one slot for review, so production work never fills the crew.
A limit of one runs one assignment at a time.
The frontier offers queued review before new production work.

A dependent starts only after its dependencies reach accepted completion.
You accept executable work from the attempt that holds it.
The Operator resolves planning work itself, so you accept planning work with no attempt.

```sh
operator work accept --request <id> --owner-token <token> --assignment <id> --attempt <id> --revision <n> --json
operator work accept --request <id> --owner-token <token> --assignment <id> --revision <n> --json
```

See [ADR 0003](docs/adr/0003-crew-state-is-one-sqlite-file-created-once.md) and [ADR 0004](docs/adr/0004-the-frontier-is-the-only-dispatch-rule.md).

## Operative dispatch and recovery

The Operator dispatches a claimed assignment into its own Herdr-managed worktree.
The dispatch names the commit it starts from, because a worktree never picks up uncommitted work from another checkout.

```sh
operator attempt dispatch --request <id> --owner-token <token> --attempt <id> --commit <sha> --json
```

The command fixes the whole launch before it acts: the branch, the checkout, the launch snapshot, the brief, and the prompt.
It then creates the worktree, copies and verifies the fixed inputs, starts the selected agent host, and submits the brief.
Each effect records its intent before the call and its outcome after it.

The worktree receives these files:

- The project configuration and its schema.
- A release record and the frozen lock data.
- A control reference and the brief.
- The skills of this release.

Dispatch copies no other file out of the controlling checkout, so credentials stay in the host credential store.

Herdr acknowledges a submission, not a turn.
A dispatch therefore reports `pending` until the Operative acknowledges its assignment from its own worktree.

```sh
operator attempt acknowledge --request <id> --attempt <id> --json
```

A Herdr call that never answered is uncertain, because a timeout does not prove that the effect did not happen.
The attempt then blocks until you reconcile it against what Herdr and the checkout show.

```sh
operator attempt reconcile --request <id> --owner-token <token> --attempt <id> --json
operator attempt show --attempt <id> --json
```

A replacement is a new attempt on the same assignment, not a second writer.

```sh
operator attempt replace --request <id> --owner-token <token> --attempt <id> --inspection <identity> --json
```

A replacement runs only when all of these are true:

- Every effect is settled.
- The former writer is proven stopped.
- The caller states the identity of the partial-work inspection it read.

The CLI keeps the inspected checkout and branch.

The launch snapshot fixes the crew host, model, release, lock data, and skills.
A recovery restores that record.
So a changed project setting or a session override blocks the attempt with a named drift, and never reaches a launch already in progress.
See [ADR 0005](docs/adr/0005-dispatch-is-staged-and-an-unproven-effect-blocks.md).

## Questions, answers, and approvals

An Operative that cannot continue inside its authority limits raises one question from its own worktree.

```sh
operator question raise --request <id> --attempt <id> --input question.json --json
operator question revise --request <id> --attempt <id> --question <id> --revision <n> --input question.json --json
```

The report states these items:

- The question, its evidence, and its options.
- The Operative's recommendation.
- The scope that waits, and the work that continues without the answer.

A report has no authority of its own, so the CLI refuses a report that states an approval.
One Operative waits on one question at a time.
Every other assignment stays dispatchable, and `operator work frontier` lists the open questions beside the work they hold.

```sh
operator question answer --request <id> --owner-token <token> --question <id> --revision <n> --input answer.json --json
```

An answer is a requirement, a human answer, or an Operator decision.
The CLI records the exact words apart from the structured reading of them, and a requirement also names its source and revision.

Some subjects go to the user and refuse an Operator decision:

- Visible behavior.
- Scope.
- Security permissions.
- Unresolved ambiguity.
- Conflicting explicit requirements.

Conflicting requirements and unresolved ambiguity also refuse a recorded requirement, because no single source closes either one.
One question revision carries one decision, and a question that nobody waits on any more takes no further change.

The Operative names those subjects when it raises the question, and the Operator records the ones it finds itself.

```sh
operator question escalate --request <id> --owner-token <token> --question <id> --revision <n> --input escalation.json --json
```

An escalation drops an Operator decision recorded before it and keeps a person's answer.

```sh
operator question deliver --request <id> --owner-token <token> --question <id> --json
operator question acknowledge --request <id> --question <id> --json
operator question show --question <id> --json
```

Recording an answer, delivering it, and receiving it are three states.
A repeated delivery reports what it already sent and does not submit the answer again.
The Operative's own acknowledgement is the only proof that the answer arrived, and it releases the work that waited.
A delivery that never answered is uncertain, so it blocks another delivery until `operator attempt reconcile` settles it.

A revised question makes its recorded answer inapplicable.
To use that answer again, you need an approval that names the answer, this question, and the revision it is reused for.

```sh
operator question reapply --request <id> --owner-token <token> --question <id> --revision <n> --answer <id> --approval <id> --json
```

```sh
operator approval grant --request <id> --owner-token <token> --input approval.json --json
operator approval revoke --request <id> --owner-token <token> --approval <id> --revision <n> --json
operator approval check --input check.json --json
```

An approval binds one action, its targets, its scope, and the revision of the request it was granted against.
It covers an action when those words match and the approval names every target of the action.
So a broader grant covers a narrower action, and never the other way round.
A grant records the person's exact words and is the only way to make an approval.
Silence, a timeout, a general direction to finish, and an Operative report grant nothing.
See [ADR 0006](docs/adr/0006-a-question-holds-only-its-own-work-and-authority-is-granted.md).

## Reviewed results and acceptance

An Operative hands over its finished result from its own worktree.

```sh
operator attempt submit --request <id> --attempt <id> --input result.json --json
```

The submission fixes these items:

- The assignment revision and the requirement revision.
- The acceptance requirements it was produced against.
- Every artifact, with its content identity.
- Every check, with its outcome.
- The known concerns and the decisions the Operative made.
- The code revisions, if there are any.

The CLI copies each path artifact into a durable store and verifies it, so the reviewer reads a fixed copy and not a worktree that keeps changing.

A submission moves the assignment to awaiting review and ends its attempt.
It is never accepted completion.
The ended attempt frees its crew slot, so a one-agent crew hands its only slot from the producer to the reviewer.

The submission registers its own review assignment, which the frontier offers first.
Claim and dispatch it like any other assignment.
Its brief carries the fixed result and tells the reviewer to load the existing `code-review` skill.
The brief requires the Standards and Spec axes to run as native sub-agents of the reviewer's own host.
Those sub-agents take no Herdr slot and no worktree of their own, and they never edit, commit, or rework.

```sh
operator review report --request <id> --review <id> --input report.json --json
operator review show --review <id> --json
```

A complete report names the submission identity it read, carries both axes exactly once, records a window for each sub-agent, and states what each axis checked.
A code result requires the diff, the requirements, and the checks.
A non-code result requires the artifacts, the requirements, the citations, and the provenance of each recorded answer.
The CLI refuses two axes that ran one after the other, and a sub-agent that ran outside the reviewer host.
A host that cannot run the axes records a blocker, not a partial review.
A blocked review is a stopped review.
`operator attempt replace` returns it to registered for one replacement reviewer, up to three attempts in all.

A review report ends the review chain, so a reviewer never submits a result and no review triggers another review.

```sh
operator review dispose --request <id> --owner-token <token> --review <id> --input dispositions.json --json
```

The Operator gives each finding one disposition:

- Corrected.
- Rejected, with a reason and the evidence that refutes it.
- Deferred, with a reason and a follow-up.

A blocker is never deferred.

```sh
operator work accept --request <id> --owner-token <token> --assignment <id> --attempt <id> --revision <n> --submission <id> --pr-head <sha> --json
```

Acceptance verifies these items:

- The current ownership and the assignment revision.
- The exact submission and both axis reports.
- A disposition on every finding, and no correction still waiting for rework.
- A passing outcome on every recorded check.
- The pull request head you name, against the head the submission stated.

A check outcome that a review observed for itself outranks the producer's own word, so a contradiction blocks.
Operator does not read the pull request itself.
Acceptance compares the head you state against the head the submission recorded, and reading a live head is separate work.
A stopped reviewer, a missing input, an unavailable review capability, a missing pull-request authority, a failed check, and a flaky check each block acceptance.
See [ADR 0007](docs/adr/0007-review-is-crew-work-and-acceptance-reads-only-recorded-evidence.md).

## Rework, limits, and invalidated results

The Operator sends a finding it accepted for correction to a fresh Operative, never to the reviewer that found it.

```sh
operator work rework --request <id> --owner-token <token> --assignment <id> --revision <n> --input cycle.json --json
```

The request names one reason.

| Reason | What the cycle answers |
| --- | --- |
| `findings` | The accepted corrections of a reported review whose findings all carry a disposition. |
| `integration` | The revisions it combines. It names a review only when it answers one. |
| `diagnostic` | The recorded checks that a test infrastructure failure may be behind. At least one of them must not have passed. |

A cycle answers a review that already reported, whatever its reason.
Each cycle states the Operator instruction and the conflicts the Operative must settle, and it records no resolution of its own.
A conflict names only work that the cycle carries, so the CLI refuses a finding from any round that no correction in this cycle answers.

The cycle returns the assignment to the frontier.
Claim it again, and dispatch it from the submitted commit.
The brief carries the fixed submission, every accepted correction with its evidence, the conflicts, the revisions to combine, fixed copies of the artifacts, and the original acceptance requirements.
One cycle produces one combined revision, which registers its own review assignment.
That reviewer receives every earlier round, its dispositions, and the cycles they delegated, and it checks the revision for regressions.
You cannot accept anything between the two revisions.

Three limits apply across sessions:

- Three correction cycles for one assignment.
- Two diagnostic reruns.
- Three attempts on one review, which is one reviewer and two replacements for each submitted revision.

A reached limit records a direction request, keeps the failure evidence, and blocks acceptance with `direction_required` until the user directs it.

```sh
operator approval grant --request <id> --owner-token <token> --input direction.json --json
```

The direction is an approval with action `limit-direction`, the assignment as its target, scope `limit:<kind>`, and the revision of the direction request as its request revision.
The request keeps the evidence of every further attempt that reached the same limit.
After a direction is spent, a new reach of that limit opens the request at the next revision, so the earlier approval covers nothing.

```sh
operator work invalidate --request <id> --owner-token <token> --assignment <id> --revision <n> --input defect.json --json
```

A defect found after acceptance keeps the acceptance, the submission, the review, and every finding.
The CLI refuses to invalidate review work, because a review holds no result of its own.
The assignment returns to the frontier as `invalidated`, and only the dependents that consumed the result pause.
A dependent that never started stays held by the dependency gate.
Accepting the corrected result releases the dependents that no other defect still holds, and a dependent that was accepted returns to the step that decided it.
See [ADR 0008](docs/adr/0008-rework-is-a-delegated-cycle-and-a-limit-blocks-acceptance.md).

## Tracker completion and recovery

Completing work on the tracker is three separate outcomes, and the CLI records and recovers each one on its own.

```sh
operator tracker record --request <id> --owner-token <token> --assignment <id> --revision <n> --input step.json --json
operator tracker recover --request <id> --owner-token <token> --operation <id> --json
operator tracker show --assignment <id> --json
operator tracker map --assignment <id> --json
```

The request names one step.

| Step | Effect |
| --- | --- |
| `resolution` | Writes the decision comment. |
| `completion` | Closes the ticket with an explicit reason. |
| `map_amendment` | Appends one amendment to the wayfinder map. |

The ticket comes from the source the assignment was registered from, so the CLI refuses a request that names another repository or issue.
GitHub is the only tracker this release supports.

Every step writes its intent, its expected actor, and its exact content before it acts, and records its write attempt and the answer that came back.
It then reads what the tracker shows and settles the step from that reading.
A comment carries its logical operation in an HTML marker, and recovery uses that marker to find it again.

A write that never returned a definite answer stays uncertain, because it may still have applied.
`operator tracker recover` reads the exact comment when the server named one.
Otherwise it reads every accessible comment page and records what the scan covered.
Two matching comments, changed content, and another author are each a conflict for a person to settle.
Another write under an uncertain operation needs an approval that names the operation and the number of attempts already recorded.

```sh
operator approval grant --request <id> --owner-token <token> --input approval.json --json
operator tracker record ... --approval <id> --json
```

Completion reads the ticket before it closes it.
If the ticket is already closed with the intended reason, the step is satisfied, and Operator does not claim that it caused the close.
A different reason, or a reopen after the close, is a conflict.

`operator tracker map` reads the map as its baseline body plus every explicit amendment.
Independent additions combine.
An incomplete scan, an edited amendment, and two amendments of one section each stop the session.
Operator never replaces a shared issue body, because an amendment is always an appended comment.

`operator tracker show` reports the three steps, what blocks each one, and what may follow it.
It exits 0 even when the tracker operation is incomplete, because the query itself succeeded.
Operator never writes a verified step again to repair another step.
See [ADR 0009](docs/adr/0009-a-tracker-update-is-three-recoverable-steps.md).

## Cleanup

Cleanup is two recorded outcomes on one attempt, and each one needs its own proof and its own approval.

```sh
operator cleanup close --request <id> --owner-token <token> --attempt <id> --json
operator cleanup remove --request <id> --owner-token <token> --attempt <id> --json
operator cleanup show --attempt <id> --json
```

`operator cleanup close` ends one Operative process.
It runs only after a durable handoff, which is a submitted result or the two axis reports of a review.
Before it stops anything, it copies the brief, the control reference, the release record, and every artifact the submission fixed into the controlling checkout, and reads each copy back.

`operator cleanup remove` disposes of one Operative checkout.
It needs a closed process, the preserved evidence verified again, and a remote copy of every commit.
It also needs an approval that names this checkout or the workflow, because acceptance alone does not grant removal.

The two outcomes are separate, so a stop that cannot be proven never holds back a removal that is already safe.
Each one recovers on its own after a restart.
Operator performs exactly two effects here, both through Herdr: the host's own stop keys, and an unforced worktree removal.
It deletes no branch and runs no Git removal.

```sh
operator cleanup hold --request <id> --owner-token <token> --attempt <id> --input hold.json --json
operator cleanup release --request <id> --owner-token <token> --attempt <id> --revision <n> --json
```

A retention hold keeps one Operative's resources.
It blocks every cleanup of its attempt until a person releases it, and it outlives the session that placed it.
`operator cleanup show` reports every hold.
See [ADR 0010](docs/adr/0010-cleanup-is-two-outcomes-behind-proof-and-approval.md).

## Coordination and recovery

One read-only command tells a crew what to do next.

```sh
operator crew next --claude --operator-host claude-code --json
```

It reads these items and reports them as one ranked list of actions:

- Readiness.
- The frontier order, dependency gates, review priority, and capacity.
- Pending acknowledgements and open questions.
- Findings with no disposition.
- Unfinished tracker steps and unfinished cleanup.

Each action names the command to run, the record it acts on, and the revision to state.
`data.waits` says what is running and what has not answered yet, with the Herdr agent that a bounded wait watches.
`data.frontier` carries the order, the gates, and the capacity that the actions come from.

Each action carries the blocker a person must settle, or nothing when the session can act alone.
The exit meaning says what the session may do on its own.

| Exit | Meaning for `crew next` |
| ---: | --- |
| 0 | At least one action needs nobody else. |
| 3 | Every open crew action waits on a person, and the result names each blocker. |
| 6 | Nothing can advance, and a bounded wait is next. |

A project that is not ready is a standing precondition, not a refusal.
Continuing without proven readiness is the user's decision, and settling it starts no work.

A fresh Operator takes the crew, settles the unproven effects, and then adopts each attempt it inherited.

```sh
operator crew own --request <id> --owner-label <label> --takeover --ownership-revision <n> --json
operator attempt reconcile --request <id> --owner-token <token> --attempt <id> --json
operator attempt adopt --request <id> --owner-token <token> --attempt <id> --json
```

Adoption states that this session read what one attempt holds.
It changes nothing about the work, the checkout, the brief, or the questions.
It runs only when every effect of that attempt is settled and its Operative is still running.
You replace an attempt whose writer is gone, and you do not adopt it.
An attempt that already ended needs neither.

The Operator-owned skill reads this one command and keeps no queue of its own.
See [ADR 0011](docs/adr/0011-one-read-only-command-owns-the-coordination-order.md).

## Development

Start with [AGENTS.md](AGENTS.md) for the engineering skill configuration and [CONTEXT.md](CONTEXT.md) for the shared vocabulary.

- [Issue tracker conventions](docs/agents/issue-tracker.md): GitHub operations, wayfinder maps, claims, and dependencies.
- [Triage labels](docs/agents/triage-labels.md): the five default triage roles.
- [Domain documentation](docs/agents/domain.md): how skills read the glossary and the architecture decisions.
- [Architecture decisions](docs/adr/): one record for each decision that is hard to reverse.

```sh
bun install
bun run quality     # The same gate CI runs: format, lint, typecheck, module boundaries, and tests.
bun run changeset   # Describe a change that reaches a consumer.
```

Production code lives in flat `modules/<feature-or-capability>/` directories.
Each module exports one interface object from `main.ts`, and `bun run lint:modules` enforces the module shape and boundaries.
`skills/` holds the skills that ship with a release.
`.agents/skills/` holds this repository's own development skills, and `skills-lock.json` records their upstream sources and hashes.

| Area | Tool |
| --- | --- |
| Runtime, package manager, and tests | Bun |
| Language | TypeScript, checked with `tsc` |
| Linting | Oxlint |
| Formatting | Oxfmt |
| Module boundaries | dependency-cruiser |
| Versioning | Changesets |
| Distribution | GitHub-hosted source and JSR |

[Map the first Operator orchestration workflow](https://github.com/fveracoechea/operator/issues/1) holds the approved scope and the decision tickets.
The approved [CLI and skill distribution contract](https://github.com/fveracoechea/operator/issues/7#issuecomment-5729841818) settles exact release selection, skill installation, updates, and runtime boundaries.
[ADR 0013](docs/adr/0013-one-release-is-one-matched-version-delivered-twice.md) records how publication works.

## References

- [Bun documentation index](https://bun.com/llms.txt)
- [Bun executable documentation](https://bun.com/docs/pm/bunx.md)
- [Herdr agent guide](https://herdr.dev/agent-guide.md)
- [Herdr CLI reference](https://herdr.dev/docs/cli-reference/)
- [Matt Pocock's skills](https://github.com/mattpocock/skills)
