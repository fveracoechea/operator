---
"@fveracoechea/operator": minor
---

`operator report accept --promote <file>` accepts a report and promotes it into a new PR assignment of the same source (ADR-0023). The PR assignment depends on the accepted report and takes over the report's worktree, whose branch takes the PR branch. A worker that still runs keeps its pane under a new Herdr name, its brief is rewritten from the PR template, and the promotion records the steering message `promoted` that tells the worker to read that brief. When the worker had stopped, the PR assignment is ready, and dispatch starts it in the same worktree. The device database gains a `promotions` table through a migration.
