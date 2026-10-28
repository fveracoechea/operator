---
"@fveracoechea/operator": patch
---

Ship the `my-opinions` skill.
It holds Francisco's opinions on building software as a router with one topic for each area, so an agent reads only the topics that its task needs.
It replaces the global `~/OPINIONS.md` file, and `pr-review` loads it before each review.
