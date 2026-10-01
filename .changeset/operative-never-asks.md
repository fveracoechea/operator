---
"@fveracoechea/operator": patch
---

Dispatch starts a Claude Code Operative with `--permission-mode dontAsk` and an allow list built from its brief: the Operator CLI commands the brief names, its allowed commands, its write paths, and an outbox for `--input` files.
The Operative never stops on a permission prompt that nobody answers.
It raises a blocked report for each tool that its host refuses.
A producer may also run `git status`, `git add`, and `git commit`, so it can commit its result, and a reviewer may not.
