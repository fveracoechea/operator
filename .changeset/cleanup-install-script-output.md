---
"@fveracoechea/operator": patch
---

Cleanup no longer stops at the worktree step when an install lifecycle script wrote ignored files, such as Husky's hook stubs in `.husky/_/`.
Preparation now records each ignored file that appeared during the install, with its content hash, and cleanup disposes such a file only while it is unchanged.
A changed or unrecorded ignored file still blocks cleanup. A worktree prepared before this release has no record, so its install output still needs `operator cleanup --person-instructed`.
