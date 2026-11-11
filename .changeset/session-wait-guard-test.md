---
"@fveracoechea/operator": patch
---

Correct the Claude turn-end guard integration test for session-scoped coordination waits.
Consume the other session's initial wait result before checking its background wait.
This fixes the reproducible release-check failure without changing runtime behavior or weakening session isolation.
