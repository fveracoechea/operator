# Skills

The skills Operator owns and hand-edits.
A release ships these directories whole.
`operator install --opencode --claude` installs complete personal copies from the running release.
Nix packages check consumer-owned links instead.

Every skill here has exactly one home, so no name in this directory is a second copy under `.agents/skills/`.
This repository reaches them through symlinks in `.agents/skills/` and `.claude/skills/`.
Write to the portable frontmatter floor, `name`, `description`, `license`, `compatibility`, and `metadata`, because opencode drops every other field without a word.
The frontmatter `name` and the directory name are the same string.
A `SKILL.md` is a router and stays under 150 lines, and every markdown file beside it is reached by a link from it.
See [ADR-0002](../docs/adr/0002-an-owned-skill-discloses-rules-through-task-specific-topics.md) for the task-specific disclosure decision.
`bun run quality` fails on any of those four rules.

- **[adr](./adr/SKILL.md)** - Use when recording an architectural decision, when an existing ADR in docs/adr looks stale against the code, or when a change contradicts an ADR.
- **[bun](./bun/SKILL.md)** - Use when writing or reviewing Bun code including runtime, bun test and its mocks, Bun.serve, bundler, bun install, or scripts.
- **[collections-and-iteration](./collections-and-iteration/SKILL.md)** - Use when code sorts, filters or looks up in an array, Set or Map, or loops over a collection or an object.
- **[deep-modules](./deep-modules/SKILL.md)** - Use when adding or changing a feature in a TypeScript app: a screen and its data, where new or shared code goes, a sub-module, or a module test.
- **[my-opinions](./my-opinions/SKILL.md)** - Use when making a design or architecture decision, reviewing code or a PR, choosing a tool, or writing a spec, PR body, or review comment.
- **[no-slop](./no-slop/SKILL.md)** - Use when writing or editing prose, documentation, code comments, commit messages, or issue and pull request text.
- **[pr-review](./pr-review/SKILL.md)** - Use when asked to review a pull request by number or URL, or when a review brief names this skill.
- **[react-best-practices](./react-best-practices/SKILL.md)** - Use when writing, reviewing or changing client side React: useEffect, useState, Suspense, derived state, re-render, a lazy chunk, or data waterfall.
- **[react-composition](./react-composition/SKILL.md)** - Use when designing, changing or reviewing the API of a React component: boolean props, render props, several parts that share state, or sibling component that must read state.
- **[slack-pr-review-workflow](./slack-pr-review-workflow/SKILL.md)** - Use when watching a Slack channel for pull requests to review, or when an Operator review wait returns Slack reads or Slack effects.
- **[tanstack-tools](./tanstack-tools/SKILL.md)** - Use when writing or changing code that uses a TanStack library: router, search params, loader, a query or mutation, form, a chart, or a server function.
- **[super-agent](./super-agent/SKILL.md)** - Use when supervising delegated WorkerAgents or coordinating a person's Operator work.
- **[worker-agent](./worker-agent/SKILL.md)** - Use when a SuperAgent delegates work with an absolute brief reference.
