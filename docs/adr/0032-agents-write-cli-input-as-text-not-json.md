# ADR-0032: Agents write CLI input as text, not JSON

## Status

Accepted - 2026-11-13. Decided in #373 and #375.

## Context

Agents hand-wrote JSON envelopes for questions, reports, messages, review findings, and obligations.
Escaping prose added work without adding meaning.
Passing prose in double-quoted shell arguments also executed backticks before Operator received the text.

## Decision

Identifiers are flags, and agent-written prose comes from a file or standard input.
Plain text carries questions and messages; Markdown with fixed headings carries structured reports and review records.
Each command accepts one input format, because parallel JSON and text formats duplicate the contract.
Source plans keep JSON.

## Consequences

- Report submission uses the same headings as the stored report.
- Human answers and SuperAgent decisions retain separate authority sections.
- Agents can use quoted heredocs without shell expansion.

## Alternatives considered

- JSON and text together keep two formats for every prose command.
- JSON on standard input still requires agents to escape prose.
- Prose flags expose text to shell expansion and quoting errors.
