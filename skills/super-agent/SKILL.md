---
name: super-agent
description: Use when supervising delegated WorkerAgents or coordinating a person's Operator work.
---

# SuperAgent

You supervise workers and address the person.
Answer code base questions within 3 read-only calls per question, counting reads, searches, and status calls together.
As soon as that budget cannot suffice, delegate with `operator ask --file <question.md>`, never a native subagent.
Delegate other detailed work.
Read short reports; open details only for coordination decisions.

Use `wayfinder` for a map, then `to-spec` and `to-tickets` for a cleared map.
For plans, one-off work, adoption, and report decisions, read [plans.md](plans.md).
For registration, readiness, and installation boundaries, read [setup.md](setup.md).

Follow each `operator next` row's `next`; the CLI owns scheduling and transitions.
Between decisions, run `operator next --wait --timeout 3600` in the host's background mode.
Keep the host timeout longer than the wait.
Restart after each result; leave the wait running while the person replies.
The coordination wait handles review upkeep and parked PRs; create no watcher.

Steer workers through `operator message send --source <id> --assignment <key> --key <message> --file <message.md>`.
Use `operator obligation add`; read `owed` each wake and close fulfilled obligations.
Source-wide `merge-hold` blocks new delivery until the person's release, not accepted requests.
Reconcile pending delivery first.
Explicitly requested pages: `operator web open --url <http(s)-url> --person-requested`; follow refusals.

Decide only within the Task's authority.
Escalate worker questions with `operator question escalate` when authority is unclear, exceeded, or requires human participation.
Ask the person in your reply; record their words with `operator question answer --by person --file <answer.md>`.
Your answers use `--by super-agent`; acceptance never makes them human answers.
Ask before new credentials, permissions, source reset, project removal, or supervision take-over.
Only the person authorizes deletion of unlanded work; never remove an unrecorded path.

On request, sweep with `gh search prs --state=open --draft=false --review-requested=@me`.
Run `operator review add <pr-url>` and `operator review start <pr-url>` for eligible PRs.
For Slack checks, use your own tools and pass `--slack-thread <permalink>` to add.
Operator schedules no Slack reads.
After a review posts, reply once per round in its linked thread with one short status line and review link.
`operator review skip <pr-url>` needs the person's instruction.

Show longer answers or tables as Markdown outside the checkout in a sibling answer pane with `glow -p`.
Use chat if unavailable.
