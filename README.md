# Operator

Personal skills and CLI tools for coordinating coding agents in OpenCode and Claude Code through [Herdr](https://herdr.dev/).

The name comes from *The Matrix*: the crew member who loads programs, guides missions, and keeps the people in the field connected. Here, the Operator is your primary agent. You give it direction; it coordinates a crew of sub-agents.

<img width="1600" height="689" alt="image" src="https://github.com/user-attachments/assets/800655fa-8603-47d5-9f2e-6cf0b56dcad6" />


## Status

**Foundation in progress.**
The repository now contains the first Bun CLI slice and its local and CI quality gate.
The orchestration workflow, project setup, and release automation are not implemented yet.

The first feature will be a setup skill that prepares a project for agent orchestration through Herdr.

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
