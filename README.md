# Operator

Personal skills and CLI tools for coordinating coding agents in OpenCode and Claude Code through [Herdr](https://herdr.dev/).

The name comes from *The Matrix*: the crew member who loads programs, guides missions, and keeps the people in the field connected. Here, the Operator is your primary agent. You give it direction; it coordinates a crew of sub-agents.

<img width="1600" height="689" alt="image" src="https://github.com/user-attachments/assets/800655fa-8603-47d5-9f2e-6cf0b56dcad6" />


## Status

**Project installation, setup, and readiness work.**
The repository contains the Bun CLI, its local and CI quality gate, `operator install`, `operator setup`, and `operator setup readiness`.
Crew orchestration, the live readiness probe, and release automation are not implemented yet.

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
