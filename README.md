# Operator

Personal skills and CLI tools for coordinating coding agents in OpenCode and Claude Code through [Herdr](https://herdr.dev/).

The name comes from *The Matrix*: the crew member who loads programs, guides missions, and keeps the people in the field connected. Here, the Operator is your primary agent. You give it direction; it coordinates a crew of sub-agents.

## Status

**Planning, not a working CLI.** This repo currently contains Matt Pocock's installed skills and their project configuration. The orchestration skill, CLI commands, quality checks, and release automation are not implemented yet.

The first feature will be a setup skill that prepares a project for agent orchestration through Herdr.

## The Workflow We Want

1. You work with the Operator to clarify a goal and choose work to delegate.
2. The Operator assigns tasks or tickets to crew members, each with its own Git worktree managed through Herdr.
3. Crew members use skills such as `implement`, `research`, `improve-codebase-architecture`, and `grilling` to do their work.
4. Crew members report findings and ask questions through the Operator. It uses established decisions and brings questions that need your judgment back to you.
5. Work passes the agreed tests and review checks before the Operator presents the results for acceptance.

You can interact with a crew member directly, but that is an optional path, not the main workflow. The Matrix-inspired name for crew members is still open.

Herdr should provide as much of the terminal and agent control as possible. Operator should add the coordination rules, skills, and CLI operations that are missing, rather than duplicate Herdr.

## Current Destination

An implementation-ready specification for the first Operator orchestration workflow: project setup, isolated crew work, questions routed through the Operator, and reviewed results. The specification must also settle the supporting CLI, distribution, release, and quality requirements.

We will use `wayfinder` to chart this work in [GitHub Issues](https://github.com/fveracoechea/operator/issues). Its map will index decision tickets and their dependencies. Questions that are not yet clear enough to become tickets will remain in the map's **Not yet specified** section.

This effort ends when the route to implementation is clear. Building and releasing the production workflow comes afterward. The map has not been created yet.

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
| Distribution | GitHub-hosted source and GitHub Packages; the exact delivery path needs verification |

The requested invocation is a design target, **not an installation command that works today**:

```sh
bunx github:fveracoechea/operator some-operation
```

A GitHub source reference and the GitHub Packages registry are different delivery paths. We still need to verify this command, version pinning, authentication, and how each path relates to a Changesets release.

Fast local feedback and CI checks must agree on what passes. The specification will define test boundaries, review gates, and failure handling before implementation starts.

## Decisions Ahead

The initial discussion needs to cover:

- What setup changes in a project, what it changes in agent configuration, and how it preserves existing settings.
- Which Herdr features cover worktree creation, agent startup, communication, monitoring, and recovery.
- What the Operator may decide alone, what requires your approval, and how human-in-the-loop skills retain real human input.
- How OpenCode and Claude Code participate in the same workflow.
- How work is claimed, reviewed, integrated, and recovered after an interruption.
- Which operations need deterministic CLI support rather than skill instructions alone.
- How skills and CLI versions are installed, updated, tested, and released together.

These are discussion areas, not a fixed backlog. Once the map exists, its decision tickets will hold the answers.

## Working in This Repo

Start with [AGENTS.md](AGENTS.md) for the engineering skill configuration and [CONTEXT.md](CONTEXT.md) for the shared vocabulary.

- [Issue tracker conventions](docs/agents/issue-tracker.md): GitHub operations, wayfinder maps, claims, and dependencies.
- [Triage labels](docs/agents/triage-labels.md): the five default triage roles.
- [Domain documentation](docs/agents/domain.md): how skills read the glossary and architecture decisions.

Installed skills live in `.agents/skills/`; `skills-lock.json` records their upstream sources and hashes. There are no application build or test commands yet.

## References

- [Bun documentation index](https://bun.com/llms.txt)
- [Bun executable documentation](https://bun.com/docs/pm/bunx.md)
- [Herdr agent guide](https://herdr.dev/agent-guide.md)
- [Herdr CLI reference](https://herdr.dev/docs/cli-reference/)
- [Matt Pocock's skills](https://github.com/mattpocock/skills)
