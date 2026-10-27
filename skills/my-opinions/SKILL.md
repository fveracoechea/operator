---
name: my-opinions
description: Use when making a design or architecture decision, reviewing code or a PR, choosing a tool, or writing a spec, PR body, or review comment.
---

# Francisco's opinions

Each rule carries its reason, so you can argue with it.

## Judgment matters more than building

These apply to every task.

- AI makes building cheap, so knowing what to build is the scarce skill.
- Good ideas start with named people who care about a real problem. Talk to them before validating your own idea.
- Learn with narrow prototypes and existing building blocks.
- Judge a technical decision on quality, simplicity, robustness, and long-term maintenance. Effort today is not a factor.

## Pick the topics

Read every topic that matches the task.
A code review reads [architecture.md](architecture.md), [code-quality.md](code-quality.md), and [pull-requests-and-writing.md](pull-requests-and-writing.md), plus the topic for the code under review.

- A tool, a runtime, a dependency, a framework, a build step, or a workspace: [toolchain.md](toolchain.md).
- A lint rule, a lint disable comment, a check, a hook, or a CI workflow: [enforcement.md](enforcement.md).
- Where code goes, a helper, an export, a factory, a module boundary, or local development: [architecture.md](architecture.md).
- Server functions, schemas, contracts, configuration, or work with a backend team: [data-and-server.md](data-and-server.md).
- Client state, the query cache, a selector, the URL, or loading states: [client-state.md](client-state.md).
- Links, navigation, dates, server-side rendering, or web platform APIs: [web-platform.md](web-platform.md).
- React components, effects, TypeScript style, or comments: [react-and-typescript.md](react-and-typescript.md).
- Tokens, design-system components, color, accessibility, charts, or a UI review: [design-systems.md](design-systems.md).
- A test or a bug fix: [testing.md](testing.md).
- Size, complexity, layers, or wrappers in a change: [code-quality.md](code-quality.md).
- ADRs, docs, a glossary, a changeset, versions, or releases: [docs-and-releases.md](docs-and-releases.md).
- A PR, a review, a commit, a spec, a proposal, or a document for readers: [pull-requests-and-writing.md](pull-requests-and-writing.md).
- Skills, agent instructions, briefs, or delegation: [working-with-agents.md](working-with-agents.md).

> "Invest in the design of the system _every day_."
> Kent Beck, Extreme Programming Explained

> "The best modules are deep. They allow a lot of functionality to be accessed through a simple interface."
> John Ousterhout, A Philosophy Of Software Design
