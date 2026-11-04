# ADR-0022: WorkerAgents reach their SuperAgent only through recorded state

## Status

Accepted - 2026-11-04.

## Context

WorkerAgents told their SuperAgent about submitted reports, draft PRs ready for internal review, started merges, refusals they could not fix, questions, and status by typing text into the SuperAgent's Herdr pane.
The person types prompts into that same pane, so a worker's text landed in the middle of a half-written prompt and was sent with it.
That text was also not a record: a restart lost it, next actions did not show it, and a worker question and its answer left no trace of who decided.
SuperAgent-to-worker steering had the same weakness, apart from report follow-up, which was already recorded.
The SuperAgent had no way to wait for a change in next actions, so it depended on that typed text to learn that something happened.

## Decision

### No typed text reaches a SuperAgent's pane

A WorkerAgent reaches its SuperAgent only through recorded Operator state.
Neither a worker nor the CLI types text into a SuperAgent's pane.
SuperAgents keep talking to other SuperAgents through Herdr, because that exchange is between supervisors and outside any assignment.

### The coordination wait

`operator next --wait [--source id] [--timeout seconds] --json` blocks until the set of next actions other than waits changes, or until its timeout ends, and then returns the normal next answer.
It reads recorded state only, because workers' PR waits, report submission, cleanup, and the Herdr plugin already record the facts that change next actions.
A timeout returns the unchanged answer, and the SuperAgent waits again.

The CLI records the set that it last returned for each scope, and a new wait compares against that recorded set.
A change that happened between two waits therefore returns at once, also after a restart.
A wait does not return just because a non-wait action exists, because a person decision that the SuperAgent left for the person would then end every wait at once.
The CLI also records each running wait with its process, so other operations can tell whether a SuperAgent is waiting.
The pane that runs the wait or dispatches a source's work is that source's supervising pane.

The SuperAgent runs the wait as a background command, so the host delivers its result as a new turn rather than as typed input.
On Claude Code this is a Bash command run in the background: the session continues, and the command's exit wakes the agent with its output.
On OpenCode it is the shell tool's background mode: its exit posts a synthetic message that resumes the session, and messages that the server admits do not touch the TUI's unsent prompt.
Herdr offers no way to hand text to an agent other than typing it: agent prompts and pane sends both type into the pane, and Herdr notifications reach the person, not the agent.
A host that cannot deliver a background result gets no typed fallback.
Its SuperAgent reads next actions when the person prompts it or runs the wait in the foreground, and the cost is a later reaction to worker events.

### Worker questions

A worker records a question for its supervising SuperAgent with a key that is unique within its assignment.
The worker identifies its assignment the same way as PR operations, through its recorded worktree or its dispatched pane, never through a selector.
The question lifecycle is an explicit state machine with the states open, awaiting person, answered, withdrawn, and abandoned.

An open question appears in next actions as a question to answer, ahead of the idle-worker attention for the same assignment.
The SuperAgent answers within its grilling authority, or moves the question to awaiting person, which next actions show as a person decision.
Every answer is recorded with `by: super-agent | person`.
`person` applies only when the person gave the answer, and an answer that the SuperAgent infers or accepts stays `super-agent`.
The worker can withdraw a question that it no longer needs.
A question that is open when its assignment ends is abandoned.

### Steering messages

A SuperAgent records a steering message for a running worker, and the CLI rings that worker's doorbell.
The doorbell is a short fixed line that names the record and carries no instruction, so a garbled or repeated doorbell changes nothing.
It is typed into the worker's pane, which no person types into.
The worker reads the message from the record and acknowledges it, and the acknowledgement can carry a short reply.
The steering lifecycle is an explicit state machine with the states pending, acknowledged, replied, closed, and abandoned.
A reply appears in next actions until the SuperAgent closes the message.
A message that stays pending past a fixed period, or whose doorbell failed, appears as worker attention.
The SuperAgent can ring the doorbell of a pending message again.

An answer to a worker question reaches the worker as a steering message, so delivery, the doorbell, and acknowledgement have one implementation.
Questions and steering keep separate lifecycles in one capability, because only a question has person escalation and an answer authority, and only steering has a reply.
Report follow-up keeps its own recorded return and resume, because acceptance depends on it.

### Turn-end guard

On Claude Code, Operator's existing Claude Code hook also handles the Stop event.
In a supervising pane, it blocks the end of a turn while next actions for that pane's sources show a running worker and no recorded coordination wait runs, and its reason tells the agent to start the wait in the background.
It blocks at most once in a row, so a SuperAgent that the person told to stop can still stop.
Unlike the commit check, this branch reads device state, and it allows the stop when the state is missing, blocked, or unreadable.
The install adds the Stop group beside the commit group, and readiness checks both.

OpenCode gets no turn-end guard in this decision.
Its only equivalent is an experimental idle hook in its plugin API, which bounds no loop and would make Operator maintain an OpenCode plugin.
The OpenCode SuperAgent starts the wait because its skill says so, which is a rule it can skip.

### What each mechanism replaces

- A worker's "report submitted" message: the coordination wait returns the report awaiting acceptance.
- A worker's "draft PR ready for internal review" message: the coordination wait returns the handoff action after the PR is associated.
- A worker's "merge started" message: the coordination wait returns the cleanup and the ended assignment after the merge is recorded.
- A refusal that the worker cannot fix: a worker question with the refusal as its content.
- A status reply: the record answers first, through next actions, PR wait results, reports, and Herdr agent state.
  A SuperAgent that needs more sends a steering message, and the worker's acknowledgement carries the reply.
- SuperAgent-to-worker steering through typed Herdr text: a steering message.

## Consequences

- Every worker event reaches the SuperAgent only as fast as its wait returns, and a SuperAgent with no wait running learns nothing until the person prompts it.
- A worker that ends its turn after it asks a question still shows the question, not an idle worker, so the SuperAgent answers rather than replaces it.
- A worker in a long turn sees its doorbell only when the host reads the typed line, so the attention period must exceed a normal turn.
- The Stop hook depends on the recorded supervising pane, so a SuperAgent that restarts in a new pane gets no guard until it dispatches or waits.
- An OpenCode SuperAgent, the device default, depends on its skill to keep a wait running.
- On Claude Code, whether a background result that arrives while the person types keeps the unsent prompt intact rests on the documented queueing of input, not on a test.

## Alternatives considered

- Typed Herdr text to the SuperAgent, also after waiting for its agent to be idle, was rejected because an idle agent says nothing about whether the person is typing.
- A doorbell in the SuperAgent's pane was rejected because even a short fixed line mixes with the person's input.
- A Herdr notification to the person as the channel was rejected because it reaches the person, not the agent, and asks the person to relay what the record already holds.
- Claude Code's cross-session message socket and channels were rejected because they work on one host only, and channels are a research preview.
- An inbox file for each SuperAgent was rejected because it would be a second store beside the device database.
- A wait that returns while any non-wait action exists was rejected because a deferred person decision would end every wait at once.
- One message lifecycle for questions and steering was rejected because its guards would branch on direction for person escalation, answer authority, and replies.
- A guard on OpenCode's experimental idle hook was rejected for now because the hook has no loop cap and its API can change.

Related: ADR-0001, the wait reads the one next-actions answer; ADR-0003, both lifecycles are explicit machines; ADR-0011, workers identify their assignment by worktree or pane; ADR-0013, answers keep the authority distinction; ADR-0017, workers report only to their SuperAgent; ADR-0020, the internal-review handoff; ADR-0021, the Claude Code hook gains a Stop branch; ADR-0023, promotion hands over a worker by steering message.
