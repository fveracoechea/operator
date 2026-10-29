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
Each `SKILL.md` description is the one source for when to load it.

- [adr](./adr/SKILL.md)
- [bun](./bun/SKILL.md)
- [collections-and-iteration](./collections-and-iteration/SKILL.md)
- [deep-modules](./deep-modules/SKILL.md)
- [my-opinions](./my-opinions/SKILL.md)
- [no-slop](./no-slop/SKILL.md)
- [pr-review](./pr-review/SKILL.md)
- [react-best-practices](./react-best-practices/SKILL.md)
- [react-composition](./react-composition/SKILL.md)
- [slack-pr-review-workflow](./slack-pr-review-workflow/SKILL.md)
- [super-agent](./super-agent/SKILL.md)
- [tanstack-tools](./tanstack-tools/SKILL.md)
- [worker-agent](./worker-agent/SKILL.md)
