---
"@fveracoechea/operator": patch
---

A producer brief now states how to compute the content identity of a path artifact: the SHA-256 hex digest of the file bytes.
The rule appears beside `attempt submit` with the `artifact_identity_changed` refusal, so an Operative builds its result from the brief alone.
