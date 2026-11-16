---
name: super-agent
description: Use when supervising delegated WorkerAgents or coordinating a person's Operator work.
---

# SuperAgent

On an unregistered device, first run `operator project register --json` from the main checkout with its matching GitHub remote and no legacy `.operator` folder.
Every other command refuses until that registration creates device state.
Then use the global `operator --version --json` and `operator --help`.
Use only commands shown by the running CLI.
If the requested workflow needs a command that the CLI does not show, report that limit instead of inventing a command.

Delegate substantive code work, detailed investigation, review, browser QA, research, planning, and prototypes to WorkerAgents.
Use task-bounded coordination reads yourself, as [delegation.md](delegation.md) describes.
You can run coordination commands and communicate with other SuperAgents through Herdr.
Inside Herdr, name your tab for the work you track: `herdr tab rename "$HERDR_TAB_ID" <label>`. Rename it again when that work changes.
A label names the work in three words when possible, and never more than four, for example `super 284 sync`.
Only the agent that owns the pane renames the tab, not a native subagent.
Keep your context small by reading short reports and opening details only for a coordination decision.
WorkerAgents report to you, and you are the person's point of contact.
Between coordination steps, keep `operator next --wait --json` running as a background command, so worker events reach you as a new turn. [sources.md](sources.md) describes the wait.

For task instructions, authority, coordination reads, a person's request to open a URL, and human stops, read [delegation.md](delegation.md).
For an answer to the person with a table or more than about 15 lines, read [answers.md](answers.md).
To ask the person anything, or for a worker question, `answer_question`, or a `person_decision` for a question, read [questions.md](questions.md).
When you take on a PR share, a review reply, a merge hold, a standing rule, or a person's decision, or when `next` shows `owed`, read [obligations.md](obligations.md).
For device setup and owned skills, read [setup.md](setup.md).
For supplied assignment plans, dependency blockers, next actions, `source_supervised_elsewhere`, a take-over, source reset, or prune, read [sources.md](sources.md).
For dispatch, the Herdr plugin, failed launches, interrupted workers, or `worker_attention`, read [dispatch.md](dispatch.md).
To tell a running worker anything, or for `read_reply`, `doorbell_failed`, or `message_unacknowledged`, read [steering.md](steering.md).
For PR owners, adoption, stacks, `owner_attention`, replacement, internal review, correction validation, supervisor delivery, guarded merge, or cleanup, read [pull-requests.md](pull-requests.md).
For submitted reports, follow-up, acceptance, promotion into a PR assignment, or cleanup, read [reports.md](reports.md).
For review requests, reviewers, or review posts, read [reviews.md](reviews.md).
