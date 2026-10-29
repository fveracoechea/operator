---
name: adr
description: Use when recording an architectural decision, when an existing ADR in docs/adr looks stale against the code, or when a change contradicts an ADR.
---

# ADR

An ADR is a short record of one architecturally significant decision: the context that forced it, the decision, and its consequences.
It records the **decision, not the implementation**, for the reader two years out who asks "why is it like this".

The test for every sentence is the **rename test**: would it still be true if every file in the repo were renamed, moved or rewritten tomorrow?
A sentence that fails describes the implementation and belongs in the code style document or in a comment at the code, citing the ADR.

[`DRIFTED-ADR-EXAMPLE.md`](DRIFTED-ADR-EXAMPLE.md) shows a drifted ADR beside its decision form.

## 1. Is it an ADR?

All three tests must hold:

1. **Hard to reverse.** Changing your mind later costs something real.
2. **Surprising without context.** A future reader would wonder why on earth.
3. **A real trade-off.** There were genuine alternatives and one was chosen for reasons.

When one fails, the fact is not an ADR. A convention goes in the code style document; a gotcha goes in a comment at the code; a mechanism that is visible from the code goes nowhere.

## 2. New, amend, supersede, or leave alone

Pick one before writing a word:

- **The implementation changed and the decision did not.** Leave the ADR alone. A renamed file or a moved module does not touch the record.
- **The decision's scope changed, or one detail of it reversed.** One clause in Status: `Amended YYYY-MM-DD: <what changed about the decision>.` The body is rewritten to read true today; no amendment section, no dated inventory of what was removed.
- **The decision was replaced.** A new ADR with the next number. The old one's Status becomes `Superseded by ADR-NNNN.` and nothing else in it changes; it is the historical record.
- **A new decision.** The next number, `NNNN-kebab-slug.md`, sequential with no gaps.

## 3. Write it in the house shape


```md
# ADR-NNNN: <the decision as a short sentence>

## Status

Accepted - YYYY-MM-DD. Decided in #NNN. Amended YYYY-MM-DD: <one clause>.

## Context

## Decision

## Consequences

## Alternatives considered

Related: ADR-NNNN (<one clause on how it relates>).
```

- **Title**: the decision, named so the filename slug reads as a sentence.
- **Status**: the only home for dates, issue numbers and amendment clauses. `Decided in` names the issue or PR where the decision was made, when there is one.
- **Context**: two to six sentences, past tense. The problem and the forces. Name what was wrong, described as behaviour a reader can recognise, without the files that had it.
- **Decision**: present tense, generic, with the because. Technology and product names are the decision (Bun, Redis, Mystique, orval); file paths, exports, scripts, env vars and versions are the implementation. A symbol appears only when it is the decision's own vocabulary and is already how the team says it.
- **Consequences**: only downstream effects a reader would not infer. Often two or three bullets. Omit the section when there are none.
- **Alternatives considered**: only rejections that someone will propose again. Omit otherwise.
- **Related**: one line, `ADR-NNNN` plus a clause. Cross-reference by number and make it reciprocal when the relation matters from both sides.

## 4. Place what the ADR left out

Every fact the rename test removed that a developer would still miss gets a home before the ADR is saved, so the ADR never has to carry it:

- A rule about how code is written: the code style document, `CODE_STYLE.md` in most Terzo repos, in the section for its area.
- A reason or gotcha bound to one place in the code: a comment at that place.
- An operator fact (a probe, a port, a script): `README.md`.

Each of those cites the ADR by number, so the link runs from the code to the decision and a reader at the code can find the why.

## 5. Self-check, then format

Done means every line below is true:

- Every sentence passes the rename test.
- Status is the only place a date, an issue number or an amendment appears.
- The header number matches the filename; every `ADR-NNNN` mentioned exists in `docs/adr/`.
- The reader two years out can answer "why is it like this" from the Context and Decision alone.
- Every fact removed in step 4 has landed where it belongs.
- The repo's formatter has run over the changed files.
