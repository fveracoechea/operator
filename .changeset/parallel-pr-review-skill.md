---
"@fveracoechea/operator": minor
---

Ship the `parallel-pr-review` skill.
It runs one `pr-review` for each pull request at the same time, each in a Claude agent in its own Herdr worktree, and returns one short bullet for each pull request with the verdict and the main feedback.
Each agent bases its review on the opinions in `~/OPINIONS.md`.
It gives each pull request of a stack its own base, verifies each verdict on GitHub, and can post the summary to a Slack thread or channel.
`operator install` copies it into a project beside the other bundled skills.
