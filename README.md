# Operator

Personal skills and CLI tools for coordinating coding agents in OpenCode and Claude Code through [Herdr](https://herdr.dev/).

The name comes from *The Matrix*: the crew member who loads programs, guides missions, and keeps the people in the field connected. Here, the Operator is your primary agent. You give it direction; it coordinates a crew of sub-agents.

<img width="1600" height="689" alt="image" src="https://github.com/user-attachments/assets/800655fa-8603-47d5-9f2e-6cf0b56dcad6" />


## Status

**Project installation, setup, readiness, the crew frontier, Operative dispatch, question routing, reviewed acceptance, delegated rework, tracker completion, and approved cleanup work.**
The repository contains the Bun CLI, its local and CI quality gate, `operator install`, `operator setup`, `operator setup readiness`, `operator crew own`, `operator work`, `operator attempt`, `operator question`, `operator approval`, `operator review`, `operator tracker`, and `operator cleanup`.
The live readiness probe and release automation are not implemented yet.

## CLI Foundation

Use `bun cli.ts --version` for human output or `bun cli.ts --version --json` for the versioned machine result.
The package also exports `main(args)` from `@fveracoechea/operator/cli`.

CLI exit meanings are stable across commands:

| Exit | Meaning |
| ---: | --- |
| 0 | Completed |
| 1 | Definite failure |
| 2 | Invalid request or input |
| 3 | Missing condition or approval |
| 4 | State or ownership conflict |
| 5 | Uncertain external effect |
| 6 | Recorded operation still pending |

## Project Installation and Setup

Install the Operator-owned skills into a project.
At least one target is required, and the CLI never guesses a target from the agents it finds.

```sh
operator install --opencode
operator install --claude
operator install --opencode --claude
```

A copy that already matches this release is adopted without a write.
A copy that was changed is a conflict, and the command then writes nothing.

Configure the project in two steps.
Setup inspects first and writes nothing until the same plan is approved.

```sh
operator setup plan --claude --json
operator setup apply --claude --approved-plan <planId> --json
```

The plan identifier covers the selected targets and the exact content of every proposed change.
A changed project or a changed target makes a new identifier, and the old approval is refused.
An unchanged rerun writes nothing.

Setup owns `.operator/config.json`, `.operator/config.schema.json`, one marked `/.operator/` block in `.gitignore`, one marked Operator section in `AGENTS.md`, and an `@AGENTS.md` import in `CLAUDE.md`.
It never commits, never changes the Git index, and never installs machine-wide software.

Setup records each completed write and the previous contents of the file.

```sh
operator setup rollback --json
```

Rollback restores only the files that still hold what setup wrote.
A file changed after setup wrote it is preserved and reported as a conflict.

## Project Readiness

Configured is not ready.
Configured means the approved setup plan is complete and the selected files and settings validate.
Ready means the required checks passed for the exact selection and inputs you are about to launch.

```sh
operator setup readiness --claude --operator-host claude-code --json
```

The command reads the machine and the project and writes nothing.
It reports one of three answers beside a separate `configured` field.

| State | Meaning |
| --- | --- |
| `blocked` | A required check failed. The blockers name the reason, the paths, and the next action. |
| `unverified` | Every required static check passed, and required live evidence is missing or stale. |
| `ready` | Every required check passed against the current inputs. |

Static checks observe the selected hosts, Bun, Git, Herdr, the GitHub CLI, the instruction files, the discoverable skill contents, the Operator release, its lock data, and the project settings.
They never prove host termination, the native review sub-agents, or provider compatibility.
Those need a live probe.

Each selection field is resolved on its own, from a session override, then `.operator/config.json`, then the host default.
A missing Crew host follows the Operator host, and a missing model stays with the selected host default.
Operator never substitutes an unavailable host or model, and it never guesses a host that nothing names.

A live probe launches agents and spends provider tokens, so it carries its own approval.

```sh
operator setup probe plan --claude --operator-host claude-code --json
operator setup probe apply --claude --operator-host claude-code --approved-probe <probeId> --json
```

The plan shows the hosts, models, provider use, temporary resources, and checks before anything launches.
A changed project or selection makes a new `probeId` and refuses the old approval.
This release runs no live check yet, so an approved probe reports that the configuration stays unverified.

Recorded live results live in `.operator/local/readiness.json` with the approved probe that produced them and the fingerprints of the inputs they were proven against.
A changed input makes its own record stale and leaves unrelated records valid.
See [ADR 0002](docs/adr/0002-readiness-is-derived-and-only-live-evidence-is-recorded.md).

## Crew State and the Frontier

One Operator owns a crew at a time.
Ownership creates the crew state, which is one SQLite database in `.operator/local/`.

```sh
operator crew own --request <id> --owner-label <label> --json
operator crew own --request <id> --owner-label <label> --takeover --ownership-revision <n> --json
```

The result carries the owner token that every later mutation must present.
A takeover names the ownership revision it inspected, so two Operators cannot both believe they won.
It invalidates the former token, so a stale Operator session cannot change crew state.

Work is registered from an approved specification, a ready ticket, or a wayfinder map.
The request is a JSON file, or `-` to read standard input.

```sh
operator work register --request <id> --owner-token <token> --input work.json --json
```

Registration records each item with its source revision, approved scope, acceptance requirements, permissions, fixed inputs, dependencies, and planning boundary.
Registering the same item twice names the existing assignment instead of creating a second one.
A dependency cycle is refused before anything is dispatched, and so is a re-registration that states different dependencies.

```sh
operator work frontier --json
operator work claim --request <id> --owner-token <token> --assignment <id> --revision <n> --json
```

The frontier reports what the crew may start now and why the rest waits.
It writes nothing.
A claim recomputes the same frontier, so it can never take work the frontier withheld.
Two concurrent claims give the assignment to one caller, and the other names the attempt that already holds it.

The crew limit defaults to three active agents and is set by `crew.maxActiveAgents` in `.operator/config.json`.
A limit of two or more holds one slot for review, so production work never fills the crew.
A limit of one runs one assignment at a time.
Queued review is offered before new production work.

A dependent starts only after its dependencies reach accepted completion.
Executable work is accepted from the attempt that holds it.
The Operator resolves planning work itself, so planning work is accepted with no attempt.

```sh
operator work accept --request <id> --owner-token <token> --assignment <id> --attempt <id> --revision <n> --json
operator work accept --request <id> --owner-token <token> --assignment <id> --revision <n> --json
```

Every mutation carries a request identity.
A repeat under the same identity returns the recorded result of a mutation that changed state, with no new effect, and `repeated` in the result says so.
A refused mutation records nothing, so a repeat of it is checked again against the current state.
Once an identity has recorded an outcome, the same identity carrying different input is refused.
See [ADR 0003](docs/adr/0003-crew-state-is-one-sqlite-file-created-once.md) and [ADR 0004](docs/adr/0004-the-frontier-is-the-only-dispatch-rule.md).

## Operative Dispatch and Recovery

A claimed assignment is dispatched into its own Herdr-managed worktree.
The dispatch names the commit it starts from, because a worktree never picks up uncommitted work from another checkout.

```sh
operator attempt dispatch --request <id> --owner-token <token> --attempt <id> --commit <sha> --json
```

The command fixes the whole launch before it acts: the branch, the checkout, the launch snapshot, the brief, and the prompt.
It then creates the worktree, copies and verifies the fixed inputs, starts the selected agent host, and submits the brief.
Each effect records its intent before the call and its outcome after it.

The worktree receives the project configuration, its schema, a release record, the frozen lock data, a control reference, the brief, and the skills of this release.
No other file is copied out of the controlling checkout, so credentials stay in the host credential store.

Herdr acknowledges a submission, not a turn.
A dispatch therefore reports `pending` until the Operative acknowledges its assignment from its own worktree.

```sh
operator attempt acknowledge --request <id> --attempt <id> --json
```

A Herdr call that never answered is uncertain, because a timeout does not prove that the effect did not happen.
The attempt then blocks until it is reconciled against what Herdr and the checkout actually show.

```sh
operator attempt reconcile --request <id> --owner-token <token> --attempt <id> --json
operator attempt show --attempt <id> --json
```

A replacement is a new attempt on the same assignment, not a second writer.

```sh
operator attempt replace --request <id> --owner-token <token> --attempt <id> --inspection <identity> --json
```

It runs only when every effect is settled, the former writer is proven stopped, and the caller states the identity of the partial-work inspection it read.
The inspected checkout and branch are retained.

The launch snapshot fixes the crew host, model, release, lock data, and skills.
A recovery restores that record, so a changed project setting or a session override blocks the attempt with a named drift instead of reaching a launch already in progress.
See [ADR 0005](docs/adr/0005-dispatch-is-staged-and-an-unproven-effect-blocks.md).

## Questions, Answers, and Approvals

An Operative that cannot continue inside its authority limits raises one question from its own worktree.

```sh
operator question raise --request <id> --attempt <id> --input question.json --json
operator question revise --request <id> --attempt <id> --question <id> --revision <n> --input question.json --json
```

The report states the question, its evidence, its options, the Operative's recommendation, the scope that waits, and the work that continues without the answer.
It carries no authority of its own, so a report that states an approval is refused.
One Operative waits on one question at a time.
Every other assignment stays dispatchable, and `operator work frontier` lists the open questions beside the work they hold.

```sh
operator question answer --request <id> --owner-token <token> --question <id> --revision <n> --input answer.json --json
```

An answer is a requirement, a human answer, or an Operator decision.
The exact words are recorded apart from the structured reading of them, and a requirement also names its source and revision.
A question that names visible behavior, scope, security permissions, unresolved ambiguity, or conflicting explicit requirements refuses an Operator decision, so it goes to the user.
Conflicting requirements and unresolved ambiguity refuse a recorded requirement too, because no single source closes either one.
One question revision carries one decision, and a question nobody waits on any more takes no further change.

The Operative names those subjects when it raises the question, and the Operator records the ones it finds itself.

```sh
operator question escalate --request <id> --owner-token <token> --question <id> --revision <n> --input escalation.json --json
```

An escalation drops an Operator decision recorded before it and leaves a person's answer standing.

```sh
operator question deliver --request <id> --owner-token <token> --question <id> --json
operator question acknowledge --request <id> --question <id> --json
operator question show --question <id> --json
```

Recording an answer, delivering it, and receiving it are three states.
A repeated delivery reports what it already sent instead of submitting the answer again.
The Operative's own acknowledgement is the only proof the answer arrived, and it releases the work that waited.
A delivery that never answered is uncertain, so it blocks another delivery until `operator attempt reconcile` settles it.

A revised question makes its recorded answer inapplicable.
Using that answer again takes an approval that names it, this question, and the revision it is reused for.

```sh
operator question reapply --request <id> --owner-token <token> --question <id> --revision <n> --answer <id> --approval <id> --json
```

```sh
operator approval grant --request <id> --owner-token <token> --input approval.json --json
operator approval revoke --request <id> --owner-token <token> --approval <id> --revision <n> --json
operator approval check --input check.json --json
```

An approval binds one action, its targets, its scope, and the revision of the request it was granted against.
It covers an action when those words match and the approval names every target of the action, so a broader grant covers a narrower action and never the other way round.
A grant records the person's exact words and is the only producer of an approval.
Silence, a timeout, a general direction to finish, and an Operative report grant nothing.
See [ADR 0006](docs/adr/0006-a-question-holds-only-its-own-work-and-authority-is-granted.md).

## Reviewed Results and Acceptance

An Operative hands over its finished result from its own worktree.

```sh
operator attempt submit --request <id> --attempt <id> --input result.json --json
```

The submission fixes the assignment revision, the requirement revision, the acceptance requirements it was produced against, every artifact with its content identity, every check with its outcome, the known concerns, the decisions the Operative made, and the code revisions where there are any.
Each path artifact is copied into a durable store and verified, so the reviewer reads a fixed copy rather than a worktree that keeps changing.

A submission moves the assignment to awaiting review and ends its attempt.
It is never accepted completion.
The ended attempt frees the crew slot it held, so a one-agent crew hands its only slot from the producer to the reviewer.

The submission registers its own review assignment, which the frontier offers first.
Claim and dispatch it like any other assignment.
Its brief carries the fixed result, tells the reviewer to load the existing `code-review` skill, and requires the Standards and Spec axes to run as native sub-agents of that reviewer's own host.
Those sub-agents take no Herdr slot and no worktree of their own, and they never edit, commit, or rework.

```sh
operator review report --request <id> --review <id> --input report.json --json
operator review show --review <id> --json
```

A complete report names the submission identity it read, carries both axes exactly once, records a window for each sub-agent, and states what each axis checked.
A code result requires the diff, the requirements, and the checks.
A non-code result requires the artifacts, the requirements, the citations, and the provenance of each recorded answer.
Two axes that ran one after the other are refused, and so is a sub-agent that ran outside the reviewer host.
A host that cannot run the axes records a blocker instead of a partial review.
A blocked review is a stopped review, so `operator attempt replace` returns it to registered for one replacement reviewer, up to three attempts in all.

A review report ends the review chain, so a reviewer never submits a result and no review triggers another review.

```sh
operator review dispose --request <id> --owner-token <token> --review <id> --input dispositions.json --json
```

Each finding is corrected, rejected with a reason and the evidence that refutes it, or deferred with a reason and a follow-up.
A blocker is never deferred.

```sh
operator work accept --request <id> --owner-token <token> --assignment <id> --attempt <id> --revision <n> --submission <id> --pr-head <sha> --json
```

Acceptance verifies the current ownership, the assignment revision, the exact submission, both axis reports, a disposition on every finding, no correction still waiting for rework, a passing outcome on every recorded check, and the pull request head you name against the head the submission stated.
A check outcome a review observed for itself outranks the producer's own word, so a contradiction blocks.
Operator does not read the pull request itself; acceptance compares the head you state against the head the submission recorded, and reading a live head remains separate work.
A stopped reviewer, a missing input, an unavailable review capability, a missing pull-request authority, a failed check, and a flaky check each block instead of passing.
See [ADR 0007](docs/adr/0007-review-is-crew-work-and-acceptance-reads-only-recorded-evidence.md).


## Rework, Limits, and Invalidated Results

A finding the Operator accepted for correction goes to a fresh Operative, never to the reviewer that found it.

```sh
operator work rework --request <id> --owner-token <token> --assignment <id> --revision <n> --input cycle.json --json
```

The request names one reason.
A `findings` cycle answers the accepted corrections of a reported review whose findings all carry a disposition.
An `integration` cycle names the revisions it combines, and names a review only when it answers one.
A review that already reported is answered either way.
A `diagnostic` cycle names the recorded checks a test infrastructure failure is suspected behind, and at least one of them must not have passed.
Each cycle states the Operator instruction and the conflicts the Operative must settle, and it records no resolution of its own.
A conflict names only work the cycle carries, so a finding of any round that no correction in this cycle answers is refused.

The cycle returns the assignment to the frontier.
Claim it again, dispatch it from the submitted commit, and the brief carries the fixed submission, every accepted correction with its evidence, the conflicts, the revisions to combine, fixed copies of the artifacts, and the original acceptance requirements.
One cycle produces one combined revision, which registers its own review assignment.
That reviewer receives every earlier round, its dispositions, and the cycles they delegated, and it checks the revision for regressions.
Nothing between the two revisions can be accepted.

Three limits hold across sessions: three correction cycles for one assignment, two diagnostic reruns, and three attempts on one review, which is one reviewer and two replacements per submitted revision.
A reached limit records a direction request, keeps the failure evidence, and blocks acceptance with `direction_required` until the user directs it.

```sh
operator approval grant --request <id> --owner-token <token> --input direction.json --json
```

The direction is an approval with action `limit-direction`, the assignment as its target, scope `limit:<kind>`, and the revision of the direction request as its request revision.
The request keeps the evidence of every further attempt that reached the same limit.
Once a direction is spent, reaching that limit again opens the request at the next revision, so the earlier approval covers nothing.

```sh
operator work invalidate --request <id> --owner-token <token> --assignment <id> --revision <n> --input defect.json --json
```

A defect found after acceptance keeps the acceptance, the submission, the review, and every finding.
Review work is refused, because a review holds no result of its own.
The assignment returns to the frontier as `invalidated`, and only the dependents that consumed the result are paused.
A dependent that never started stays held by the dependency gate.
Accepting the corrected result releases the dependents no other defect still holds, and one that was accepted returns to the step that decided it.
See [ADR 0008](docs/adr/0008-rework-is-a-delegated-cycle-and-a-limit-blocks-acceptance.md).


## Tracker Completion and Recovery

Completing work on the tracker is three separate outcomes, and each one is recorded and recovered on its own.

```sh
operator tracker record --request <id> --owner-token <token> --assignment <id> --revision <n> --input step.json --json
operator tracker recover --request <id> --owner-token <token> --operation <id> --json
operator tracker show --assignment <id> --json
operator tracker map --assignment <id> --json
```

The request names one step: `resolution` writes the decision comment, `completion` closes the ticket with an explicit reason, and `map_amendment` appends one amendment to the wayfinder map.
The ticket comes from the source the assignment was registered from, so a request that names another repository or issue is refused.
GitHub is the only tracker this release implements.

Every step writes its intent, its expected actor, and its exact content before it acts, and records its write attempt and the answer that came back.
It then reads what the tracker actually shows and settles the step from that reading.
A comment carries its logical operation in an HTML marker, which is how recovery finds it again.

A write that never returned a definite answer stays uncertain, because it may still have applied.
`operator tracker recover` reads the exact comment when the server named one, and otherwise reads every accessible comment page and records what the scan covered.
Two matching comments, changed content, and another author are each a conflict for a person to settle.
Another write under an uncertain operation needs an approval that names the operation and the number of attempts already recorded:

```sh
operator approval grant --request <id> --owner-token <token> --input approval.json --json
operator tracker record ... --approval <id> --json
```

Completion reads the ticket before it closes it.
An observed closed state with the intended reason satisfies the step without claiming that Operator caused it, and a different reason or a reopen after the close is a conflict.

`operator tracker map` reads the map as its baseline body plus every explicit amendment.
Independent additions combine; an incomplete scan, an edited amendment, and two amendments of one section each stop the session.
Operator never replaces a shared issue body: an amendment is an appended comment, and no request can ask for anything else.

`operator tracker show` reports the three steps, what each one is blocked by, and what may follow it.
It answers 0 even when the tracker operation is incomplete, because the query itself succeeded.
A verified step is never written again to repair another.
See [ADR 0009](docs/adr/0009-a-tracker-update-is-three-recoverable-steps.md).


## The Workflow We Want

1. You work with the Operator to clarify a goal and choose work to delegate.
2. The Operator assigns tasks or tickets to crew members, each with its own Git worktree managed through Herdr.
3. Crew members use skills such as `implement`, `research`, `improve-codebase-architecture`, and `grilling` to do their work.
4. Crew members report findings and ask questions through the Operator. It uses established decisions and brings questions that need your judgment back to you.
5. Work passes the agreed tests and review checks before the Operator presents the results for acceptance.
6. The Operator closes completed crew agents and removes their Herdr-managed worktrees after results are preserved and the required approval is in place. Pending cleanup remains visible until it is complete or explicitly deferred.

You can interact with a crew member directly, but that is an optional path, not the main workflow. The Matrix-inspired name for crew members is still open.

Herdr should provide as much of the terminal and agent control as possible. Operator should add the coordination rules, skills, and CLI operations that are missing, rather than duplicate Herdr.

## Current Destination

An implementation-ready specification for the first Operator orchestration workflow: project setup, isolated crew work, questions routed through the Operator, and reviewed results. The specification must also settle the supporting CLI, distribution, release, and quality requirements.

Follow [Map the first Operator orchestration workflow](https://github.com/fveracoechea/operator/issues/1) for the approved scope and current decision tickets. The map uses native GitHub sub-issues and blocking relationships. Questions that are not yet clear enough to become tickets remain in its **Not yet specified** section.

This effort ends when the route to implementation is clear. Building and releasing the production workflow comes afterward.

## Technical Requirements

These are requirements for the planned implementation, not tools already configured in this repo.

| Area | Requirement |
| --- | --- |
| Runtime | Bun for all Operator CLI code |
| Language | TypeScript with explicit type checking |
| Linting | Oxlint |
| Formatting | Oxfmt |
| Tests | Bun tests, including end-to-end checks of CLI behavior |
| Versioning | Changesets |
| Releases | Automated GitHub Actions release workflow |
| Distribution | Both GitHub-hosted source and GitHub Packages |

The requested invocation is a design target, **not an installation command that works today**:

```sh
bunx github:fveracoechea/operator some-operation
bunx @fveracoechea/operator some-operation
```

A GitHub source reference and the GitHub Packages registry are different delivery paths. The approved [CLI and skill distribution contract](https://github.com/fveracoechea/operator/issues/7#issuecomment-5653511210) defines authentication, exact release selection, skill installation, updates, runtime boundaries, and publication approval. The actual CLI and release flow still need implementation and end-to-end verification.

Fast local feedback and CI checks must agree on what passes. The specification will define test boundaries, review gates, and failure handling before implementation starts.

## Decision Tracking

The map is the planning index, not a build backlog. Each child ticket holds one question and, when resolved, its answer. Human decision tickets require live discussion; research findings do not stand in for user approval.

The open discussions include [Matrix-inspired crew terminology](https://github.com/fveracoechea/operator/issues/6) and [safe crew cleanup after completion](https://github.com/fveracoechea/operator/issues/12).

## Working in This Repo

Start with [AGENTS.md](AGENTS.md) for the engineering skill configuration and [CONTEXT.md](CONTEXT.md) for the shared vocabulary.

- [Issue tracker conventions](docs/agents/issue-tracker.md): GitHub operations, wayfinder maps, claims, and dependencies.
- [Triage labels](docs/agents/triage-labels.md): the five default triage roles.
- [Domain documentation](docs/agents/domain.md): how skills read the glossary and architecture decisions.

Installed skills live in `.agents/skills/`; `skills-lock.json` records their upstream sources and hashes.
Run `bun run quality` for the same formatting, linting, typechecking, module-boundary, and test gate used in CI.

## References

- [Bun documentation index](https://bun.com/llms.txt)
- [Bun executable documentation](https://bun.com/docs/pm/bunx.md)
- [Herdr agent guide](https://herdr.dev/agent-guide.md)
- [Herdr CLI reference](https://herdr.dev/docs/cli-reference/)
- [Matt Pocock's skills](https://github.com/mattpocock/skills)
