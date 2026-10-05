---
"@fveracoechea/operator": patch
---

A cleanup that refuses with `identity_mismatch` now names a malformed control reference apart from a missing one.
For a malformed reference, the `control-reference` mismatch reports `found` as `malformed:` with the problem and each field that has no usable value.
A missing reference still reports `none`.
