# ADR-0027: A question becomes a one-assignment report source in one command

## Status

Accepted - 2026-11-11.
Decided in the SuperAgent retro of 2026-11-11, finding 2.

## Context

A retro of six SuperAgent sessions found that each SuperAgent read code, queried tools, and dug through CI logs itself.
Its reasons were that a quick look was enough and that the worker route took longer.
A delegated question needed a plan file, `source register`, and `dispatch`, so a lookup was cheaper to do than to delegate.
That reading filled 180k to 360k characters of the SuperAgent's context per session.

## Decision

`operator ask --question <text>` registers the question as a new source with one read-only report assignment and dispatches its worker in the same command.
The CLI builds the plan. The SuperAgent writes no plan file.

- Each question gets the new tracker key `ask:<8 hex digits>`, so the same question asked twice never meets an open parent.
- The assignment key is the first six words of the question as a slug, or `question` when the question has no letters or digits.
- The assignment uses `pane` resources, so the worker changes no project files.
- The instructions quote the question and ask for a short conclusion, evidence with paths, supporting files, and unresolved points.
- An optional `--profile` names the start profile.
- The report completes through SuperAgent acceptance, as ADR-0013 describes.

A failed dispatch keeps the registered source.
The refusal names the `operator dispatch` command that starts it again, and `next` shows it as a ready assignment.

## Consequences

- A question that needs more than one status call costs the SuperAgent one command and one report read.
- `ask` composes `source register` and `dispatch` and adds no new state, so `next`, reports, acceptance, reset, and prune treat the source like any other.
- Each question is its own source, so `next` shows one source row per open question.
- A question for work that changes files still needs a supplied plan with `worktree` resources.

## Alternatives considered

- A `--file` plan template was rejected, because writing the plan file was the cost to remove.
- Adding the question to an open source was rejected, because a plan is fixed after registration.
