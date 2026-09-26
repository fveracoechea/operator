# Readiness is derived on each run, and only live evidence is recorded

A project is *configured* when its approved setup plan is complete and its selected files and settings validate.
It is *ready* only when the required checks passed for that exact configuration.

Every static check, such as tool presence, skill contents, instruction loading, release match, and lock data, is cheap and observes the current machine and project.
So readiness recomputes them on every run and writes nothing.
A recorded static result could only disagree with the files and tools it describes.

Live checks are different.
They launch agents, spend provider tokens, and need separate approval, so they cannot run on every readiness question.
Their results are recorded in `.operator/local/readiness.json`, each with the approved probe that produced it and the fingerprints of the inputs it was proven against.
A later run recomputes those fingerprints and marks a record stale when its own inputs changed.
Unrelated records stay valid, because each record names only the inputs its check depends on.
A record that names no approved probe has no provenance, so the whole file is refused.

Readiness therefore reports three states, plus a separate `configured` field:

- `blocked`: a required check failed, and the report names the blocker and the next action. A live check that a probe proved to fail blocks in the same way a static check does.
- `unverified`: every required static check passed, but required live evidence is missing or stale.
- `ready`: every required check passed against the current inputs.

A static check never reports a live capability as proven.
Host termination, the native review sub-agents, and provider compatibility are live checks, so a project with no live evidence is `unverified`, never `ready`.

## Considered options

A readiness flag stored at the end of setup was rejected.
It answers the question at the wrong time, and it cannot see a tool that was removed or a skill copy that was edited after setup finished.

A time-based expiry on recorded evidence was rejected.
An hour changes nothing about a checked configuration, and a changed host binary invalidates the evidence immediately.
Input fingerprints invalidate on the event that matters.

One fingerprint over all inputs was rejected.
It is simpler, but any change would invalidate every recorded check, and the contract requires that unrelated evidence survive.

## Consequences

`operator setup readiness` is read-only.
The live probe owns every write to the evidence record.

The fingerprint names are a durable contract, held as a union type so a rename is a compile error.
A rename still invalidates recorded evidence, so it needs the schema version to change.

One successful host pairing does not verify another, because the resolved Operator and Crew selection is part of the `selection` fingerprint.
