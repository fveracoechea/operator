---
"@fveracoechea/operator": minor
---

A plan can set an optional `maxRunning` running cap (ADR-0006).
While that many of its assignments have a starting or live worker, `operator next` lists none of its ready assignments and shows each one as a wait with `running_cap_reached` and its `runningCap`.
`operator dispatch` refuses a held assignment with `running_cap_reached`, and the launch reservation checks the cap again, so two dispatches cannot both pass it.
PR owners in their feedback loop and internal reviewers count toward the cap. A replacement worker is not held.
