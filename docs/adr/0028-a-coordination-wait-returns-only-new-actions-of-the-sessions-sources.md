# ADR-0028: A coordination wait returns only new actions of the session's sources

## Status

Accepted - 2026-11-11.
Amends ADR-0022 and ADR-0001. Builds on ADR-0025, which makes the agent session the supervisor.
Decided in the SuperAgent retro of 2026-11-11, finding 1.

## Context

ADR-0022 made the coordination wait return the whole next answer whenever the set of non-wait actions changed.
Six SuperAgent sessions showed what that cost.
Each wake carried every source, so a wait returned about 25 `source_ended` rows and every unchanged row on each wake. One `question_awaiting_person` came back 95 times.
Wake payloads outweighed all other tool output, and 40% to 66% of wakes needed no action: an action that turned back into a wait, the SuperAgent's own `message close`, or an owner whose PR wait timed out and started again.
SuperAgents worked around it with one wait per source, home-made JSON filters, and sleep loops.
`operator review wait` repeated every review request on each wake in the same way.

## Decision

A coordination wait returns only the actions that its scope has not returned yet.
Each scope stores the keys of the actions it returned: the source, the assignment, the action, its reason, and the question or message that the action names.
A key that went away leaves the stored set, so its return is new again. A removed action never ends a wait.
A key that appears during a wait counts from its second read, two seconds later.

A SuperAgent command from an agent session, such as `dispatch`, `message send`, or `question escalate`, records the actions that it added to its named source, or to a source that it registered, as returned by every wait of that session.
A wait reads the stored set on each read, so a change that its own session made never ends it.

`pr_wait_timed_out`, `pr_wait_stopped`, `pr_owner_idle`, and `worker_idle` count only once they lasted a minute, because an owner usually starts its next PR wait, or a worker turns active, within that time.

A wait without a source from an agent session has its own scope for that session. It covers every source that the session supervises in every project, and it claims the current project's open sources that nobody supervises yet. Without a session, it covers the current project as before.

`next` leaves an ended source's `source_ended` row out and shows the source only with its prune or owed cleanup. A wait returns a newly ended source's `source_ended` once, so the SuperAgent can tell the person. A scope's first wait records the ends it finds without returning them.
`--all` returns the whole board on `next` and on both waits.
`operator review wait` returns its events with only the requests that the events name and those with an action.

## Consequences

- A wake carries only new rows, so it costs a few hundred characters instead of thousands.
- One wait serves a SuperAgent that supervises sources in several projects.
- A new action can arrive up to two seconds later, and a settling one a minute later.
- An action that disappears and reappears between two waits, with no wait running, is not new to the next wait.
- A stored set from an earlier release holds tuples, which read as the same keys, so a project or source wait returns only rows that name a question or message once after an upgrade. The first session wait has no stored set, so it returns every open action once.

## Alternatives considered

- Keeping the whole answer and leaving filtering to agents was rejected, because the agents' filters broke and still woke them.
- Ignoring all changes from the calling session by time window was rejected, because it would also hide a worker's change in that window.
- A per-source wait loop was rejected, because the turn-end guard and the supervising session already know the session's sources.
