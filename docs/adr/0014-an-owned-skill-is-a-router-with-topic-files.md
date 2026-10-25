# ADR-0014: An owned skill discloses rules through task-specific topics

## Status

Accepted.
Amended 2026-10-24: Apply the existing disclosure decision to device-installed skills and the SuperAgent and WorkerAgent vocabulary, as resolved in #209 and #232.

## Context

Agent hosts loaded skill descriptions before a task selected the skill.
Long descriptions charged every turn for rules that most tasks did not need.
Complete skill directories also carried unused and duplicate content to every installation.

## Decision

An owned skill loads only the rules that its current task needs.
A skill with multiple topics uses a small router with a trigger and pointers to those topics.
Rules that always apply can remain in the router, including the five rules of the person for SuperAgents.
A small skill that agents read in full keeps its rules together until a second topic justifies a split.

A description states when to load the skill, not its rules.
Topic headings identify the rules without a duplicate rule list or a compiled copy.
Complete supporting content belongs to the skill's one maintained home.
The skill-writing guidance owns authoring conventions, while this decision fixes the disclosure policy for Operator-owned skills.

## Consequences

- A wrong topic pointer costs another read, so router wording needs care.
- There is no second complete rendering for readers who prefer all topics in one document.
- Installation checks can establish content identity, but they do not prove which files a running host loaded.

## Alternatives considered

- One long document for every skill was rejected because a narrow task then loads unrelated rules.
- One file for each rule was rejected because related rules require many reads and installations carry more files.
- A compiled copy beside the topics was rejected because it duplicates content and drifts after edits.

Related: ADR-0028, device installation owns content checks rather than live discovery; ADR-0036, the development-only testing skill follows the same disclosure policy; ADR-0037, renamed role skills retain one home without forwarding copies.
