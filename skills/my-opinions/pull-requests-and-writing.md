# Pull requests and writing

## Pull requests

- Small PRs, one concern each. A large change becomes a reviewable stack.
- Group small tickets of the same kind in one PR, up to 30 files, so reviewers are not flooded with PRs. Above 30 files, split into a stack.
- Make a stack reviewable commit by commit. Each commit closes one issue, and the handoff links each commit.
- The PR body says where to start reading, what looks wrong and is not, what was verified with exact commands, where it departs from the spec, and what is not done here.
- Name out-of-scope items and their tickets instead of fixing them in passing.
- Review findings are in scope. Fix them in the same PR and reply on each thread, with no follow-up tickets.
- Verify claims against reality. Run the command against a real ref, read the upstream source, and say plainly what is still unproven.
- A commit message carries the why and names no agent as co-author.

## Reviews

- A review judges where the change landed before it judges the lines. Correct code in the wrong module is a finding, and the diff is the cheapest moment to move it.
- Review comments are short and friendly, with blockers separated from nice-to-haves, and read like a person wrote them.

## Specs and proposals

- A proposal is a request for comments that starts a conversation, not a full spec.
- A spec or RFC carries no time estimates. An estimate in a proposal turns into a commitment and pulls focus from the decision.
- Research does not ship. Findings go on the ticket.

## Writing

- A document for readers starts with an overview of what it is and the friction. No internal codes, such as S1, in headings or text.
- Write in ASD-STE100 Simplified Technical English, with one sentence per line in Markdown and no em dash.
