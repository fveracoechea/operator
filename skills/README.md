# Skills

The skills Operator owns and hand-edits.
A release ships these directories whole, and `operator setup` copies them into a consumer project.

Every skill here has exactly one home, so no name in this directory is a second copy under `.agents/skills/`.
This repository reaches its own owned skills through a symlink instead.
Write to the portable frontmatter floor, `name`, `description`, `license`, `compatibility`, and `metadata`, because opencode drops every other field without a word.
The frontmatter `name` and the directory name are the same string.
A `SKILL.md` is a router and stays under 150 lines, and every markdown file beside it is reached by a link from it, as [ADR-0014](../docs/adr/0014-an-owned-skill-is-a-router-with-topic-files.md) records.
`bun run quality` fails on any of those four rules.

- **[no-slop](./no-slop/SKILL.md)** - Use when writing or editing prose, documentation, code comments, commit messages, or issue and pull request text.
- **[operator](./operator/SKILL.md)** - Use when preparing a project for Operator, running approved work through a crew, or resuming an Operator session that ended.
- **[pr-review](./pr-review/SKILL.md)** - Use when reviewing a pull request by number or URL, or posting review comments on one.
