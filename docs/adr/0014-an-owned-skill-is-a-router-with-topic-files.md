# An owned skill is a router, and its rules live in topic files

A release delivers the Operator-owned skill directories whole, and an installation copies every file in them into the consumer project.
A file that no task reads is therefore carried by every project that installs Operator.
The description is loaded on every turn in both supported agents, and no portable frontmatter field turns model invocation off, so every owned skill is model invoked and every description is paid for on every turn.
Both costs are paid per turn and per consumer, not once by the author.

So an owned skill discloses progressively.
`SKILL.md` is a router.
It carries the trigger, the one or two claims the skill turns on, and the pointers to the topic files, and it does not carry the rules.
A topic file groups the rules that fire together, so one task loads one file and carries none of the others into its context.

A skill an agent reads in full is one `SKILL.md`, and it carries its rules there.
Below roughly 150 lines there is nothing to disclose, and a router plus one topic file buys a future split at the price of a second read on every use.
The split happens on the second topic, not at a line count.

The headings of a topic file are the rule index, so the file carries no separate rules list.
A list beside the sections states each rule a second time, and the two copies disagree after the first rewording.

No compiled copy of the skill sits beside the skill.
A document that repeats the whole skill doubles what a consumer carries and gives every rule a second source of truth.

The description says when to load the skill and nothing else.
It is the only part every agent pays for on every turn, so it opens on the trigger, names the distinct cases, and stops.
What the skill is and what it contains stay in the body, because an agent reads the body only after the pointer fires.

The `writing-for-agents` skill is the source of truth for how to write a skill.
This record fixes only what Operator requires of the skills it owns and ships.

## Considered options

One long `SKILL.md` per skill was rejected.
It needs no pointers, it cannot send an agent to the wrong file, and a reader sees every rule at once.
It also loads every rule for every task, so a turn that needed one section carries the whole file.

One file per rule was rejected.
It loads the least text a task can need, and each rule is edited without touching its neighbours.
Rules that fire together then arrive as many separate reads, and a consumer carries one file per rule forever, which is the cost this record exists to avoid.

A compiled copy of every rule beside the skill was rejected.
It lets a reader or a reviewer read the whole skill in one file, and upstream skills the repository evaluated ship one.
It doubles what every consumer carries, and the copy and the topic files disagree as soon as one of them is edited.

## Consequences

A router costs a second read when the pointer sends the agent to the wrong topic file.
The cure is the wording of the pointer, not a fatter router.
A router that answers the question itself has stopped being a router.

`bun run quality` runs `scripts/check-skill-shape.ts` over `skills/`.
It fails when the frontmatter `name` and the directory name differ, when the frontmatter carries a field outside the portable floor, when a `SKILL.md` is over 150 lines, and when a markdown file beside a `SKILL.md` is not reached by a link from that `SKILL.md`.
The last check is what keeps a consumer from carrying a topic file no pointer reaches.

An installation places the skills the project's release names, and it does not guarantee that those are the skills an agent loads.
A skill installed for the person is served ahead of a skill of the same name installed for the project, and it replaces the whole skill, the router and every topic file together.
The replacement is silent, so a project can run skill text its release never named, and nothing reports the difference.

A skill that predates this record changes shape when someone next edits it, not before.
