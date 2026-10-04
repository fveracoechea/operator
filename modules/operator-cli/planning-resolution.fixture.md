## Planning record

### Decision 1

**Question:** Do we roll out behind a flag?

**Authority:** human answer

> Yes, behind a flag.

**Summary:** Roll out behind a flag.

**Directives:**

- Guard the new path with the rollout flag.

**Applies to:**

- The rollout of the new path.

### Decision 2

**Question:** Is the old path kept?

**Authority:** requirement, quoted from the approved scope of `<assignment>` at revision `<scope-revision>`

**Escalation triggers:** scope

> Build the tracker completion path.

**Summary:** Only the completion path is built.

**Directives:**

- Remove the old path.
- Keep one update path.

**Applies to:**

- The tracker update.

### Decision 3

**Question:** Why one path?

**Authority:** requirement, quoted from `OPINIONS.md` at revision `<copy-revision>`

> Two update paths drift.

**Summary:** One update path.

**Directives:**

- Delete the old path when the new one lands.

**Applies to:**

- The tracker update.

## Rejected options

A second update path.
