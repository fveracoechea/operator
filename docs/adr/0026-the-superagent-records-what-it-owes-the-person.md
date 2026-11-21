# ADR-0026: The SuperAgent records what it owes the person

## Status

Accepted - 2026-11-11.
Decided in the SuperAgent retro of 2026-11-11, finding 3.

## Context

A retro of six SuperAgent sessions found commitments that lived only in the conversation.
PRs were never shared for review five times, reviews went unwatched, a person's answer given in chat was never recorded and came back on 27 wakes, and standing rules such as "only use dev:trane" had to be repeated.
Next actions showed recorded work, but nothing recorded what the SuperAgent itself had promised, so a long session or a restart lost it.

## Decision

Each work source has a ledger of obligations: keyed records of what the SuperAgent owes the person.
An obligation has a kind, a short summary, and an optional reference such as a PR URL or a thread link.
The kinds are `pr-share`, `review-reply`, `merge-hold`, `standing-rule`, and `person-decision`.
A key names one obligation for the whole source, so a retry cannot add it twice.
An obligation is open until the SuperAgent closes it, and the ledger keeps closed obligations until the source is pruned.

`operator obligation add`, `close`, and `list` take `--source`, because the ledger belongs to the source rather than to one assignment.
An ended source takes no new obligation, but its open obligations stay closable.

`operator next` lists each open obligation in the source's `owed` field, beside its actions and waits.
An obligation is not an action, so the coordination wait ignores it.
The SuperAgent adds and closes obligations itself, and counting them as actions would wake its own wait for its own write, which the retro found to be most of its wasted wakes.

A person's answer to a worker question is recorded with `operator question answer --by person` as soon as the SuperAgent has it, not as an obligation.
`person-decision` covers a decision that has no question to answer yet, such as a choice for an assignment that is not dispatched.

## Consequences

- The SuperAgent's skill tells it to record an obligation as it takes one on and to read `owed` on each wake, because Operator cannot observe a promise made in chat.
- The ledger is a record, not a state machine of external effects. Operator does not post a share or a reply, so the SuperAgent closes the obligation after it acts.
- An ended source can keep showing an obligation until the SuperAgent closes it or the source is pruned.

## Alternatives considered

- Next actions rows for obligations were rejected because they would change the action set on every addition and close, and wake the SuperAgent for its own writes.
- A ledger per assignment was rejected because a standing rule or a PR share can outlive the assignment that raised it, and rules apply to the whole source.
- A free-form notes file in device state was rejected because next actions could not show it as structured records and a key could not prevent duplicates.

Related: ADR-0001, next actions own the coordination order; ADR-0003, explicit lifecycle decisions; ADR-0022, the coordination wait and worker questions.
