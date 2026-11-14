# ADR-0031: Every CLI result names its next step

## Status

Accepted. Related: ADR-0019.

## Context

About 110 refusals misled workers, and only about 32 of about 298 refusal details named a step (#349, #351).

## Decision

Every result, refusal, and next-action row carries `next`: a command and why, or who decides and the question, or why nothing is left.
A refusal also carries `reason` and only the `state` it checked.
Text mode prints at most three lines.
Worker results add the kind and the phase.

## Consequences

Skills drop refusal sections and step lists.
A new command or refusal must state its `next`.
This costs an explicit next-step decision for each command and refusal.

## Alternatives considered

- Prose steps in `detail` only leave agents to extract commands and choices from free text.
- RFC 9457 field names describe problems but do not name the next workflow step.
- A separate status command adds another read before an agent can act on the result it already has.
