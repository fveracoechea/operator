---
"@fveracoechea/operator": major
---

Replace the Slack review transport with manual review requests that apply the author policy and keep optional thread links for SuperAgent status replies.
This breaks the previous transport commands, channel setting, and bundled Slack workflow skill contract.
Remove calls to `operator review ingest`, `operator review slack-done`, and `operator review slack-drop`.
Remove `review.channel` from new configuration and stop using `review wait --slack`.
Use `operator review add <pr-url> [--slack-thread <permalink>]` to register eligible PRs under `review.repos` and `review.authors`.
Replace references to the removed `slack-pr-review-workflow/SKILL.md` with `super-agent/SKILL.md` for request intake and status replies.
The SuperAgent reads Slack through its own tools and replies in the linked thread after each posted review round.
Operator no longer reads Slack or records reply acknowledgements and retries.
Update review-origin consumers from `slack` to `manual`; `assignment` remains the other origin.
Read the optional thread permalink from `slackThread`.
The shipped manual-review migration renames the stored origin and removes the retired Slack watch/effect tables.
Previously valid channel-bearing configuration remains readable without rewriting managed files.
Installation removes unchanged managed copies of the retired workflow and preserves unowned or modified copies.
