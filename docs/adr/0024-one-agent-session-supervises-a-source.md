# ADR-0024: One agent session supervises a source

## Status

Accepted - 2026-11-11.
Amends ADR-0022.

## Context

ADR-0022 made the Herdr pane that last ran a source's coordination wait or dispatched its work the source's supervising pane, and the turn-end guard asked for that pane.
A retro of six SuperAgent sessions found two failures of that rule.
Two SuperAgents steered the same PR, because nothing stopped a second SuperAgent from running coordination commands for a source that another one supervised.
A session that was not a SuperAgent got the turn-end guard for a source, because a new session in the supervising pane inherits the pane's sources.

The pane is also a weak identity on OpenCode.
One OpenCode server runs every session on the device, and a shell command inherits the server's environment, so its `HERDR_PANE_ID` can name the pane that started the server.
Both hosts name the session that runs a shell command: OpenCode sets `OPENCODE_SESSION_ID` for each shell command, and Claude Code sets `CLAUDE_CODE_SESSION_ID`.
Both hooks receive the same session id: Claude Code's Stop event carries `session_id`, and OpenCode's idle event carries `sessionID`.

## Decision

### The session supervises

A source records its supervising agent session beside its supervising pane.
A coordination wait for the source, or a dispatch of its work, records the caller's pane and session.
A wait without a source claims only open sources that have neither a supervising pane nor a supervising session.
Each coordination wait records its session too.

The CLI reads the caller's session from `OPENCODE_SESSION_ID`, then from `CLAUDE_CODE_SESSION_ID`.
OpenCode wins because it names the session of each shell command, while a shared OpenCode server can carry the Claude Code session of the pane that started it.
Empty text names no session, and a bad value never stops the CLI from starting.

### Another session is refused

A coordination command for a source refuses with `source_supervised_elsewhere` when another session supervises the source.
The detail names the supervising session and its pane, says that nothing changed, and names the take-over.
The commands are `dispatch`, `next --wait --source`, `report accept` and `return`, `question escalate` and `answer`, `message send`, `ring` and `close`, `cleanup`, and `handoff`.
One check in front of the command handlers decides for all of them, so a new coordination command joins one list.
Reads, worker commands, and a wait without a source are not checked.
A command that carries `--person-instructed` is not checked, because the person ordered it.
A source with no recorded session passes, also when a pane holds it from before this decision, and the next wait or dispatch from a session claims it.
A failed read leaves the command to run and report its own refusal.

### The person moves supervision

`operator source take-over --source <id> --person-instructed` makes the calling pane and session the supervisor, whoever held it, and returns the previous supervisor.
It refuses with `person_instruction_required` without the flag, as `source reset` does.
A caller without a session clears the session, which leaves the source to the next wait or dispatch.
There is no automatic take-over from a session that looks gone, because Operator cannot tell an ended session from a quiet one, and the person decides who supervises.

### The guard speaks to the session

The turn-end guard asks for the hook's session, not for a pane.
It answers a reason while the sources that the session supervises have running work and no live coordination wait from that session covers them.
The Claude Code hook reads `session_id` from the Stop event and no longer needs `HERDR_PANE_ID`.
The OpenCode plugin's command passes the idle event's `sessionID` and no longer reads Herdr's pane list, so the plugin file and its version marker do not change.
A new session in the supervising pane, a subagent's session, and a session that only waits for another session's sources get no reason.

## Consequences

- A SuperAgent that restarts, or a Claude Code session after `/clear`, gets a new session id. It is refused for its old sources until the person tells it to take them over, and it gets no guard for them meanwhile.
- A session outside Herdr can supervise, and the refusal says that it runs outside Herdr.
- A coordination command run by hand from a terminal without an agent session is refused for a supervised source, so the person uses the take-over or runs it from the supervising session.
- The check and the command's own write are separate transactions. Two sessions that race on an unclaimed source can both pass, and the later claim wins.
- A host that stops exporting its session variable makes every claim pane-only, which no session supervises, and the guard goes quiet for that host.
- The person-instructed exemption trusts the attestation, as for reset and cleanup.

## Alternatives considered

- Keeping the pane as the identity and mapping it to a session through Herdr's pane list was rejected because a shell command's pane can be the OpenCode server's pane, and Herdr maps only sessions it knows.
- A `--take-over` flag on each coordination command was rejected because it would spread an authority flag across every command, and one command records the person's decision once.
- Refusing only dispatch and the wait was rejected because a second SuperAgent steered a PR through steering messages and report decisions, not through a dispatch.
- An automatic take-over when the supervising session ends was rejected because neither host reports an ended session to Operator.

Related: ADR-0003, the decisions stay outside the lifecycle machines; ADR-0017, one SuperAgent supervises delegated work; ADR-0022, the coordination wait and the turn-end guard.
