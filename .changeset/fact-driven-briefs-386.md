---
"@fveracoechea/operator": major
---

Render compact worker briefs from record facts and kind data, with the task and quoted intent.
Leave workflow commands and authority rules in the worker guide, and omit empty sections.

Replace references to removed role-skill topics with the compact routers and kind guides.
The following paths are relative to the installed skill root:

- Under `super-agent/`, remove references to `answers.md`, `delegation.md`, `dispatch.md`, `obligations.md`, `pull-requests.md`, `questions.md`, `reports.md`, `reviews.md`, `sources.md`, and `steering.md`.
- Use `super-agent/SKILL.md` for coordination, questions, steering, obligations, review intake, and authority rules.
- Use `super-agent/plans.md` for plans, one-off dispatch, adoption, report decisions, parking, and supervised merge guidance.
- Keep `super-agent/setup.md` for registration, readiness, and installation boundaries.
- Under `worker-agent/`, remove references to `internal-review.md`, `pull-requests.md`, `responsibility.md`, and `steering.md`.
- Use `worker-agent/SKILL.md` for shared worker rules and the guide named by the launch's brief.
- The six guides are `worker-agent/kinds/research.md`, `worker-agent/kinds/answer.md`, `worker-agent/kinds/prototype.md`, `worker-agent/kinds/implementation.md`, `worker-agent/kinds/review.md`, and `worker-agent/kinds/pr-feedback.md`.

Update external links, prompt templates, and explicit skill-file inventories; the removed topic paths have no bundled aliases.
Load the kind guide for work methods and follow CLI `next` results for workflow steps instead of expecting command lists in each brief.
