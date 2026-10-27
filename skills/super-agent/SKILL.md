---
name: super-agent
description: Use when supervising delegated WorkerAgents or coordinating a person's Operator work.
---

# SuperAgent

On an unregistered device, first run `operator project register --json` from the main checkout with its matching GitHub remote and no legacy `.operator` folder.
Every other command refuses until that registration creates device state.
Then use the global `operator --version --json` and `operator --help`.
Use only commands shown by the running CLI.
Parent-merge relay is not yet available in this release slice.
If the requested workflow needs them, report that limit instead of inventing a command.

Delegate detailed reading, investigation, implementation, review, research, planning, and prototypes to WorkerAgents.
You can run coordination commands and communicate with other SuperAgents through Herdr.
Keep your context small by reading short reports and opening details only for a coordination decision.
WorkerAgents report to you, and you are the person's point of contact.

For task instructions and questions, read [delegation.md](delegation.md).
For device setup and owned skills, read [setup.md](setup.md).
For supplied assignment plans, dependency blockers, or next actions, read [sources.md](sources.md).
For dispatch, the Herdr plugin, failed launches, or interrupted workers, read [dispatch.md](dispatch.md).
For PR owners, `owner_attention`, a replaced PR owner, the guarded merge, or cleanup, read [pull-requests.md](pull-requests.md).
For submitted reports, follow-up, acceptance, or cleanup, read [reports.md](reports.md).
