---
"@fveracoechea/operator": major
---

Replace the Slack review transport with manual review requests that apply the author policy and keep optional thread links for SuperAgent status replies.
This breaks the previous transport commands, channel setting, and bundled Slack workflow skill contract.
Previously valid channel-bearing configuration remains readable without rewriting managed files.
Installation removes unchanged managed copies of the retired workflow and preserves unowned or modified copies.
