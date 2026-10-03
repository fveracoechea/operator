---
"@fveracoechea/operator": minor
---

`work register` now refuses input that it accepted before.
It reads the file of each path fixed input and refuses a missing file or other bytes, as `fixed_input_mismatch`, and a path outside the checkout, as `invalid_work_input`.
`attempt dispatch` refuses a launch of production work whose base commit does not hold a path fixed input with its registered content identity, before any agent starts.
