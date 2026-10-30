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

Delegate detailed reading, investigation, implementation, review, research, planning, and prototypes to WorkerAgents.
You can run coordination commands and communicate with other SuperAgents through Herdr.
Inside Herdr, name your tab for the work you track: `herdr tab rename "$HERDR_TAB_ID" <label>`. Rename it again when that work changes.
A label names the work in three words when possible, and never more than four, for example `super 284 jarvis`.
Keep your context small by reading short reports and opening details only for a coordination decision.
WorkerAgents report to you, and you are the person's point of contact.

For task instructions, questions, and the stops that need the person, read [delegation.md](delegation.md).
For device setup and owned skills, read [setup.md](setup.md).
For supplied assignment plans, dependency blockers, next actions, source reset, or prune, read [sources.md](sources.md).
For dispatch, the Herdr plugin, failed launches, interrupted workers, or `worker_attention`, read [dispatch.md](dispatch.md).
For PR owners, `owner_attention`, a replaced PR owner, the guarded merge, or cleanup, read [pull-requests.md](pull-requests.md).
For submitted reports, follow-up, acceptance, or cleanup, read [reports.md](reports.md).
For review requests, reviewers, or review posts, read [reviews.md](reviews.md).
